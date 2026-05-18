import { Component, OnInit, OnDestroy, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ImageCropperComponent, ImageCroppedEvent, ImageTransform } from 'ngx-image-cropper';
import { DocumentService } from '../../services/document.service';
import { AdministrativeSourceTypeService, AdministrativeSourceType } from '../../services/administrative-source-type.service';
import { ModalService } from '../../../../shared/modal/modal.service';

declare var Dynamsoft: any;

@Component({
  selector: 'app-scan',
  standalone: true,
  imports: [CommonModule, FormsModule, ImageCropperComponent],
  templateUrl: './scan.component.html',
  styleUrl: './scan.component.css'
})
export class ScanComponent implements OnInit, OnDestroy {
  private readonly scanInitTimeoutMs = 15000;
  private readonly scanAcquireTimeoutMs = 150000; // 2.5 minutes for full ADF batches
  private readonly dwtInitRetryMs = 500;
  private readonly dwtInitMaxRetries = 20;
  private dwtInitRetries = 0;
  private dwtReadyHandlerRegistered = false;
  DWTObject: any = null;

  adminSourceTypeId: number = 0;

  // Load administrative source types from API (SRS requirement)
  administrativeSourceTypes: AdministrativeSourceType[] = [];
  isLoadingTypes: boolean = false;

  // Scanner devices
  scanners: string[] = [];
  selectedScanner: string = '';
  useAdf: boolean = false; // ADF Support

  isScanning: boolean = false;
  hasScannedImage: boolean = false;
  hasCapturedImage: boolean = false;
  capturedImageSrc: string | null = null;
  uploadedFile: File | null = null;

  // Image Editor State
  isEditingImage: boolean = false;
  canvasRotation: number = 0;
  transform: ImageTransform = {};
  gammaValue: number = 1.0;
  private originalBlob: Blob | null = null;
  private gammaApplyVersion: number = 0;
  editorImageBase64: string | null = null;
  croppedImageBlob: Blob | null = null;
  croppedImageSrc: string | null = null;

  // Multi-page Support
  scannedImageCount: number = 0;
  currentEditingIndex: number = 0;
  editedBase64Images: string[] = [];
  isProcessingPdf: boolean = false;
  previewPageIndex: number = 0;
  pagePreviewSources: string[] = [];

  statusMessage: string = '';
  isUploading: boolean = false;

  // Form validation
  formErrors: { [key: string]: string } = {};
  // UI state for attachment list
  selectedDocument: string | null = null;

  constructor(
    private documentService: DocumentService,
    private adminSourceTypeService: AdministrativeSourceTypeService,
    private modalService: ModalService
  ) { }

  chooseDocument(docTitle: string) {
    this.selectedDocument = docTitle;
    // reset preview when selecting a new document
    this.resetForm();
  }

  openExampleModal() {
    this.modalService.open({
      title: 'Example Popup',
      content: '<p>This is an example popup running inside the host app. Close to continue.</p>'
    });
  }

  ngOnInit(): void {
    this.loadAdministrativeSourceTypes();
  }

  ngAfterViewInit(): void {
    this.initDynamicWebTwain();
  }

  private initDynamicWebTwain(): void {
    if (typeof Dynamsoft === 'undefined' || !Dynamsoft.DWT) {
      if (this.dwtInitRetries < this.dwtInitMaxRetries) {
        this.dwtInitRetries++;
        setTimeout(() => this.initDynamicWebTwain(), this.dwtInitRetryMs);
      }
      return;
    }

    this.dwtInitRetries = 0;

    // Explicitly set the absolute path to the resource folder
    Dynamsoft.DWT.ResourcesPath = '/assets/Resources';
    
    // Force DWT to use the Local Service (required for hardware scanners).
    // If set to false or omitted (in recent versions), it may fall back to
    // WebAssembly mode which cannot access local USB scanners.
    Dynamsoft.DWT.UseLocalService = true;

    if (!this.dwtReadyHandlerRegistered) {
      Dynamsoft.DWT.RegisterEvent('OnWebTwainReady', () => {
        this.DWTObject = Dynamsoft.DWT.GetWebTwain('dwtcontrolContainer');
        this.loadScanners();
      });
      this.dwtReadyHandlerRegistered = true;
    }
    if (Dynamsoft.DWT.AutoLoad === false && typeof Dynamsoft.DWT.Load === 'function') {
      Dynamsoft.DWT.Load();
    }
  }

  private loadScanners(): void {
    if (!this.DWTObject) return;

    this.scanners = [];

    if (typeof this.DWTObject.GetSourceNamesAsync === 'function') {
      this.DWTObject.GetSourceNamesAsync().then((names: string[]) => {
        this.scanners = names;
        this.selectedScanner = this.getBestCompatibleScanner(names);
      }).catch((err: any) => console.error('Failed to get scanner sources:', err));
    } else {
      if (this.DWTObject.SourceCount > 0) {
        for (let i = 0; i < this.DWTObject.SourceCount; i++) {
          this.scanners.push(this.DWTObject.GetSourceNameItems(i));
        }
        this.selectedScanner = this.getBestCompatibleScanner(this.scanners);
      }
    }
  }

  private getBestCompatibleScanner(names: string[]): string {
    if (!names || names.length === 0) return '';

    // Group available drivers by their actual physical device base name
    const deviceGroups = new Map<string, string[]>();
    
    for (const name of names) {
      // Remove connection prefixes to find the "base" device name
      const baseName = name.replace(/^(Twain64-|WIA-|WIATWAIN-)/i, '').trim();
      if (!deviceGroups.has(baseName)) {
        deviceGroups.set(baseName, []);
      }
      deviceGroups.get(baseName)!.push(name);
    }
    
    // We pick the first detected physical device and find its best driver
    const firstBaseDevice = Array.from(deviceGroups.keys())[0];
    const availableDrivers = deviceGroups.get(firstBaseDevice)!;
    
    // Sort drivers naturally if they have versions (e.g. v2.0 vs v1.0) so newer appears first
    availableDrivers.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    // Prefer standard 32-bit TWAIN (most reliable for native UI), then WIA, finally 64-bit wrappers
    const scannerStandard = availableDrivers.find(n => !n.startsWith('Twain64-') && !n.startsWith('WIA-'));
    const scannerWia = availableDrivers.find(n => n.startsWith('WIA-'));
    const scanner64 = availableDrivers.find(n => n.startsWith('Twain64-'));
    
    return scannerStandard || scannerWia || scanner64 || availableDrivers[0];
  }

  ngOnDestroy(): void {
    if (this.DWTObject) {
      Dynamsoft.DWT.DeleteDWTObject('dwtcontrolContainer');
    }
  }

  loadAdministrativeSourceTypes(): void {
    this.isLoadingTypes = true;
    this.adminSourceTypeService.getAll().subscribe({
      next: (types) => {
        this.administrativeSourceTypes = types;
        if (types.length > 0) {
          this.adminSourceTypeId = types[0].id; // Default to first type
        }
        this.isLoadingTypes = false;
      },
      error: (err) => {
        console.error('Failed to load administrative source types', err);
        this.statusMessage = 'Failed to load document types. Please refresh the page.';
        this.isLoadingTypes = false;
      }
    });
  }

  startScan() {
    // If there's already a captured image, append a new page instead of replacing
    if (this.hasCapturedImage) {
      this.appendScan();
      return;
    }

    this.isScanning = true;
    this.hasScannedImage = false;
    this.hasCapturedImage = false;
    this.scannedImageCount = 0;
    this.currentEditingIndex = 0;
    this.editedBase64Images = [];
    this.previewPageIndex = 0;
    for (const source of this.pagePreviewSources) {
      if (source.startsWith('blob:')) {
        URL.revokeObjectURL(source);
      }
    }
    this.pagePreviewSources = [];
    if (this.DWTObject) {
       this.DWTObject.RemoveAllImages();
    }
    this.statusMessage = 'Initializing scanner...';

    if (!this.DWTObject) {
      this.initDynamicWebTwain();
      this.statusMessage = 'Preparing scanner service...';
      setTimeout(() => this.performScan(true), 700);
      return;
    }

    this.performScan(true);
  }

  appendScan() {
    this.isScanning = true;
    this.hasScannedImage = false;
    this.hasCapturedImage = false;
    // We intentionally keep editedBase64Images so we can append to the document
    this.statusMessage = 'Initializing scanner to add page...';
    
    if (this.DWTObject) {
       this.DWTObject.RemoveAllImages(); // Clear buffer so DWT only contains the NEWly scanned pages
    }

    if (!this.DWTObject) {
      this.initDynamicWebTwain();
      this.statusMessage = 'Preparing scanner service...';
      setTimeout(() => this.performScan(true), 700);
      return;
    }

    this.performScan(true);
  }

  private performScan(canRetryOnLock: boolean): void {
    if (!this.DWTObject) {
      this.statusMessage = 'Scanner is not ready yet. Please try again or wait a moment.';
      this.isScanning = false;
      this.hasScannedImage = false;
      return;
    }

    // Try to clear stale source/session state before opening the scanner.
    this.releaseScannerLocks(false);

    // Check if any scanners are actually detected by the service
    if (this.scanners.length === 0 && this.DWTObject.SourceCount === 0) {
      this.statusMessage = 'No scanners detected! Please ensure the scanner is plugged in, properly installed, and there is no 32-bit/64-bit driver mismatch.';
      this.isScanning = false;
      return;
    }

    this.statusMessage = 'Connecting to scanner...';

    // Identify selected device index
    let selectPromise: Promise<any>;
    const selectedIndex = this.scanners.indexOf(this.selectedScanner);

    if (selectedIndex !== -1 && typeof this.DWTObject.SelectSourceByIndexAsync === 'function') {
      selectPromise = this.DWTObject.SelectSourceByIndexAsync(selectedIndex);
    } else if (selectedIndex !== -1 && typeof this.DWTObject.SelectSourceByIndex === 'function') {
      // synchronous fallback wrapped in promise
       selectPromise = new Promise((resolve, reject) => {
          if (this.DWTObject.SelectSourceByIndex(selectedIndex)) {
              resolve(true);
          } else {
              reject(new Error('SelectSourceByIndex failed'));
          }
       });
    } else {
      selectPromise = this.DWTObject.SelectSourceAsync(); 
    }

    this.withTimeout(selectPromise, this.scanInitTimeoutMs, 'Scanner selection timed out')
      .then(() => {
        // Explicit instruction so user knows they have to find the hidden popup window
        this.statusMessage = 'Scanner connected. The scanner software has opened! Please check your taskbar or behind your browser window to click "Start".';
        
        const deviceConfig: any = {
           IfShowUI: true, // MUST BE TRUE! Most HP and TWAIN64 drivers crash with 'General failure' if UI is bypassed.
           IfCloseSourceAfterAcquire: true // Updated to IfCloseSourceAfterAcquire per the guide
        };
        
        // Only set ADF properties if explicitly using ADF. Forcing false can freeze flatbed-only drivers.
        if (this.useAdf) {
           deviceConfig.IfFeederEnabled = true;
           deviceConfig.IfAutoFeed = true;
        }

        return this.withTimeout(this.DWTObject.AcquireImageAsync(deviceConfig), this.scanAcquireTimeoutMs, 'Image acquisition timed out');
      }).then(() => {
        this.statusMessage = 'Document scanned. Loading editor...';
        this.hasScannedImage = true;
        this.scannedImageCount = this.DWTObject.HowManyImagesInBuffer;
        
        setTimeout(() => {
          if (this.scannedImageCount > 0) {
            this.captureImage(0);
          } else if (this.scannedImageCount === 0) {
             // Sometimes WIA resolves immediately but scans implicitly in background
             this.statusMessage = 'Waiting for scanner to capture document...';
          }
        }, 500);
      }).catch((exp: any) => {
        const errorMsg = String(exp?.message ?? exp ?? 'Unknown scanner error');
        console.error(errorMsg);

        if (canRetryOnLock && this.isMaxApplicationLockError(errorMsg)) {
          this.statusMessage = 'Scanner is busy in another session. Releasing lock and retrying...';
          this.releaseScannerLocks(true);
          setTimeout(() => this.performScan(false), 600);
          return;
        }

        let friendlyError = errorMsg;
        if (errorMsg.includes('Source Manager unable to find the specified Source') || errorMsg.includes('has no source')) {
          friendlyError = 'Scanner connection failed. The scanner might be in use by another app (like Windows Fax and Scan), or its driver is corrupted. Try restarting the scanner, closing other apps, or selecting the WIA- version of your scanner from the list.';
        } else if (this.isMaxApplicationLockError(errorMsg)) {
          friendlyError = 'Scanner is connected to the maximum number of applications. Close other scanning apps and browser tabs, then try again.';
        }

        this.statusMessage = 'Error during scanning: ' + friendlyError;
        this.isScanning = false;
        this.hasScannedImage = false;

        // Ensure we unlock the scanner for future attempts
        this.releaseScannerLocks(true);
      });
  }

  private isMaxApplicationLockError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('maximum supported number of applications');
  }

  private releaseScannerLocks(closeManager: boolean = false): void {
    if (!this.DWTObject) {
      return;
    }

    try {
      this.DWTObject.CloseSource();
    } catch (e) { }

    if (closeManager) {
      try {
        this.DWTObject.CloseSourceManager();
      } catch (e) { }
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      promise.then((value) => {
        clearTimeout(timeoutHandle);
        resolve(value);
      }).catch((error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
    });
  }

  captureImage(index: number = 0) {
    if (this.DWTObject && this.DWTObject.HowManyImagesInBuffer > index) {
      this.currentEditingIndex = index;
      this.originalBlob = null;
      this.DWTObject.ConvertToBlob(
        [index],
        Dynamsoft.DWT.EnumDWT_ImageType.IT_PNG,
        (result: Blob) => {
          const fileName = `Scan_Page_${index + 1}.png`;
          this.uploadedFile = new File([result], fileName, { type: 'image/png' });
          this.originalBlob = result;
          this.blobToDataUrl(result).then((dataUrl) => {
            this.editorImageBase64 = dataUrl;
            this.capturedImageSrc = dataUrl;
          });
          this.hasCapturedImage = true;
          this.isEditingImage = true; // Enter edit mode immediately
          this.statusMessage = `Editing Page ${this.currentEditingIndex + 1} of ${this.scannedImageCount}.`;
          
          if (index === 0) {
             this.isScanning = false;
          }
        },
        (errorCode: number, errorString: string) => {
          console.error(`Error converting image: ${errorString}`);
          this.statusMessage = 'Error capturing image from scanner.';
        }
      );
    } else {
      this.statusMessage = 'No image scanned to confirm.';
    }
  }

  rotateLeft(): void {
    if (!this.DWTObject || this.DWTObject.HowManyImagesInBuffer <= 0) {
      return;
    }
    try {
      const idx = this.DWTObject.CurrentImageIndexInBuffer;
      this.DWTObject.RotateLeft(idx);
      this.statusMessage = 'Rotated left.';
    } catch (e: any) {
      this.statusMessage = e?.message ?? 'Rotate left failed.';
    }
  }

  rotateRight(): void {
    if (!this.DWTObject || this.DWTObject.HowManyImagesInBuffer <= 0) {
      return;
    }
    try {
      const idx = this.DWTObject.CurrentImageIndexInBuffer;
      this.DWTObject.RotateRight(idx);
      this.statusMessage = 'Rotated right.';
    } catch (e: any) {
      this.statusMessage = e?.message ?? 'Rotate right failed.';
    }
  }

  stopScan() {
    this.isScanning = false;
    this.hasScannedImage = false;
    if (this.DWTObject) {
      this.DWTObject.RemoveAllImages();
    }
  }

  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      this.originalBlob = null;
      this.uploadedFile = file;
      this.scannedImageCount = 1; // It's just a single file upload context
      if (file.type === 'application/pdf') {
         // Cannot edit PDF via ngx-image-cropper
         this.hasCapturedImage = true;
         this.isEditingImage = false;
         this.editorImageBase64 = null;
         this.capturedImageSrc = null;
         this.statusMessage = 'PDF selected. Ready to upload.';
      } else {
         const reader = new FileReader();
        reader.onload = (e: any) => {
          const dataUrl = String(e.target.result ?? '');
          this.editorImageBase64 = dataUrl;
          this.capturedImageSrc = dataUrl;
          this.originalBlob = file;
          this.pagePreviewSources = [dataUrl];
          this.previewPageIndex = 0;
        };
         reader.readAsDataURL(file);
         this.hasCapturedImage = true;
         this.isEditingImage = true; // Enter edit mode immediately
         this.statusMessage = 'File selected. You can now edit it.';
      }
    }
  }

  imageCropped(event: ImageCroppedEvent) {
    this.croppedImageBlob = event.blob || null;
    if (this.croppedImageBlob) {
      this.croppedImageSrc = URL.createObjectURL(this.croppedImageBlob);
    }
  }

  editorRotateLeft() {
    this.canvasRotation--;
  }

  editorRotateRight() {
    this.canvasRotation++;
  }

  editorZoomIn() {
    this.transform = {
      ...this.transform,
      scale: (this.transform.scale || 1) + 0.1
    };
  }

  editorZoomOut() {
    const currentScale = this.transform.scale || 1;
    // Prevent zooming out too far so the document doesn't disappear/overflow backwards
    if (currentScale > 0.2) {
      this.transform = {
        ...this.transform,
        scale: currentScale - 0.1
      };
    }
  }

  rotateCanvasLeft(): void {
    this.canvasRotation--;
  }

  rotateCanvasRight(): void {
    this.canvasRotation++;
  }

  toggleFlipHorizontal(): void {
    this.transform = {
      ...this.transform,
      flipH: !this.transform.flipH
    };
  }

  toggleFlipVertical(): void {
    this.transform = {
      ...this.transform,
      flipV: !this.transform.flipV
    };
  }

  resetFitAndScale(): void {
    this.transform = {};
    this.canvasRotation = 0;
  }

  resetScaleToOne(): void {
    this.transform = {
      ...this.transform,
      scale: 1
    };
  }

  async confirmEdit() {
    if (!this.croppedImageBlob) {
      this.statusMessage = 'No cropped image available to confirm.';
      return;
    }
    this.statusMessage = 'Applying enhancements...';
    try {
      const finalBlob = this.croppedImageBlob;
      
      // Store edited page
      const base64Str = await this.blobToBase64(finalBlob);
      this.editedBase64Images.push(base64Str);
      this.pagePreviewSources.push(URL.createObjectURL(finalBlob));
      this.previewPageIndex = this.pagePreviewSources.length - 1;
      
      if (this.currentEditingIndex + 1 < this.scannedImageCount) {
         // Reset tools and move to next page
         this.canvasRotation = 0;
         this.transform = {};
         this.gammaValue = 1.0;
         this.captureImage(this.currentEditingIndex + 1);
      } else {
        // All pages in THIS batch edited!
        if (this.editedBase64Images.length > 1) {
          this.previewPageIndex = 0;
          this.isEditingImage = false;
          this.statusMessage = 'All pages collected. Use Previous/Next to review before uploading.';
        } else {
          // Single page upload flow
          const fileName = this.uploadedFile?.name || `Processed_${new Date().getTime()}.png`;
          this.uploadedFile = new File([finalBlob], fileName, { type: finalBlob.type || 'image/png' });
          this.capturedImageSrc = URL.createObjectURL(finalBlob);
          this.isEditingImage = false;
          this.statusMessage = 'Document confirmed. Ready to upload.';
        }
      }
    } catch (e: any) {
      this.statusMessage = 'Failed to apply enhancements: ' + (e?.message || 'Unknown error');
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]); // return purely the base64 part
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  private async generateMultiPagePdf(): Promise<File> {
    this.statusMessage = 'Generating multi-page PDF...';
    
    // Clear unedited original images
    this.DWTObject.RemoveAllImages();
    
    // Load all edited images back into DWT
    let loadedCount = 0;
    try {
       for (const b64 of this.editedBase64Images) {
          await new Promise<void>((resolve, reject) => {
             this.DWTObject.LoadImageFromBase64Binary(b64, Dynamsoft.DWT.EnumDWT_ImageType.IT_PNG, () => resolve(), 
             (errCode: number, errStr: string) => reject(new Error(errStr)));
          });
          loadedCount++;
       }
       
       // Convert loaded images natively into a PDF
       const indices = Array.from({length: loadedCount}, (_, i) => i);
       
       const pdfBlob = await new Promise<Blob>((resolve, reject) => {
         this.DWTObject.ConvertToBlob(indices, Dynamsoft.DWT.EnumDWT_ImageType.IT_PDF, (blob: Blob) => resolve(blob), (errCode: number, errStr: string) => reject(new Error(errStr)));
       });

       return new File([pdfBlob], `ScannedDocument_${new Date().getTime()}.pdf`, { type: 'application/pdf' });
       
    } catch (error: any) {
       throw new Error('Error generating PDF: ' + error.message);
    }
  }

  cancelEdit() {
    if (confirm('Are you sure you want to discard current edits?')) {
      this.resetForm();
    }
  }

  deleteCurrentPage(): void {
    if (!this.hasCapturedImage) {
      return;
    }

    if (!confirm('Delete only the current page?')) {
      return;
    }

    // If we are actively editing a scanned batch page, skip this page and continue.
    if (this.isEditingImage && this.scannedImageCount > 0) {
      const hasNextScannedPage = this.currentEditingIndex + 1 < this.scannedImageCount;
      if (hasNextScannedPage) {
        const deletedPageNumber = this.currentEditingIndex + 1;
        this.captureImage(this.currentEditingIndex + 1);
        this.statusMessage = `Page ${deletedPageNumber} deleted. Editing next page.`;
        return;
      }

      // Last scanned page in the batch being edited.
      if (this.pagePreviewSources.length > 0) {
        this.isEditingImage = false;
        this.previewPageIndex = Math.min(this.previewPageIndex, this.pagePreviewSources.length - 1);
        this.statusMessage = 'Current page deleted.';
        return;
      }

      this.resetForm();
      this.statusMessage = 'Current page deleted. No pages left.';
      return;
    }

    if (this.pagePreviewSources.length > 0) {
      this.removePageAtIndex(this.previewPageIndex);

      if (this.pagePreviewSources.length === 0) {
        this.resetForm();
        this.statusMessage = 'Current page deleted. No pages left.';
        return;
      }

      this.previewPageIndex = Math.min(this.previewPageIndex, this.pagePreviewSources.length - 1);
      this.scannedImageCount = this.pagePreviewSources.length;
      this.statusMessage = 'Current page deleted.';
      return;
    }

    // Fallback for single file/PDF scenarios where no page array exists.
    this.resetForm();
    this.statusMessage = 'Current page deleted.';
  }

  cleanAllPages(): void {
    if (!this.hasCapturedImage) {
      return;
    }

    if (!confirm('Clean all pages? This will remove the entire document.')) {
      return;
    }

    this.resetForm();
    this.statusMessage = 'All pages cleaned.';
  }

  private removePageAtIndex(index: number): void {
    if (index < 0 || index >= this.pagePreviewSources.length) {
      return;
    }

    const source = this.pagePreviewSources[index];
    if (source && source.startsWith('blob:')) {
      URL.revokeObjectURL(source);
    }

    this.pagePreviewSources.splice(index, 1);

    if (index < this.editedBase64Images.length) {
      this.editedBase64Images.splice(index, 1);
    }
  }

  onGammaInput(): void {
    if (this.gammaValue < 0.3) {
      this.gammaValue = 0.3;
    }
    if (this.gammaValue > 2.5) {
      this.gammaValue = 2.5;
    }
    this.statusMessage = `Preview gamma: ${this.gammaValue.toFixed(1)} (release slider to apply).`;
  }

applyBrightness(): void {
    const applyVersion = ++this.gammaApplyVersion;

    if (this.gammaValue < 0.3) this.gammaValue = 0.3;
    if (this.gammaValue > 2.5) this.gammaValue = 2.5;

    // If DWT buffer is available and contains images, operate on the current buffer image
    if (this.DWTObject && this.DWTObject.HowManyImagesInBuffer > 0) {
      const index = this.DWTObject.CurrentImageIndexInBuffer;
      if (index < 0) {
        alert('No image selected');
        return;
      }

      this.DWTObject.ConvertToBlob(
        [index],
        Dynamsoft.DWT.EnumDWT_ImageType.IT_PNG,
        (result: Blob) => {
          const sourceBlob = this.originalBlob || result;
          if (!this.originalBlob) this.originalBlob = result;

          this.applyGammaCorrection(sourceBlob, this.gammaValue)
            .then((correctedBlob) => {
              if (applyVersion !== this.gammaApplyVersion) return;

              // Replace the buffer image with corrected image
              try {
                this.DWTObject.LoadImageFromBinary(
                  correctedBlob,
                  () => {
                    try { this.DWTObject.RemoveImage(index); } catch (e) {}
                    try { this.DWTObject.CurrentImageIndexInBuffer = this.DWTObject.HowManyImagesInBuffer - 1; } catch (e) {}
                  },
                  (errorCode: number, errorString: string) => {
                    console.error('Failed to load corrected image: ', errorString);
                  }
                );
              } catch (e) {
                console.error('DWT update failed:', e);
              }

              // Update preview for immediate feedback
              this.blobToDataUrl(correctedBlob).then((dataUrl) => {
                if (applyVersion !== this.gammaApplyVersion) return;
                this.croppedImageBlob = correctedBlob;
                this.croppedImageSrc = dataUrl;
                this.editorImageBase64 = dataUrl;
                this.capturedImageSrc = dataUrl;
                this.statusMessage = `Gamma applied (${this.gammaValue.toFixed(1)}).`;
              }).catch((e) => console.error('Failed to create preview data URL:', e));
            })
            .catch((error) => {
              console.error('Gamma correction failed:', error);
            });
        },
        (errorCode: number, errorString: string) => {
          console.error('Failed to extract image for brightness adjustment: ', errorString);
        }
      );

      return;
    }

    // Non-DWT flow: use uploaded/cropped/original blob and apply gamma correction
    const sourceBlob = this.croppedImageBlob || this.uploadedFile || this.originalBlob || null;
    if (!sourceBlob) {
      alert('No image available to apply brightness to.');
      return;
    }

    this.applyGammaCorrection(sourceBlob, this.gammaValue)
      .then((correctedBlob) => {
        if (applyVersion !== this.gammaApplyVersion) return;

        const fileName = this.uploadedFile?.name || `Processed_${Date.now()}.png`;
        this.uploadedFile = new File([correctedBlob], fileName, { type: 'image/png' });

        this.blobToDataUrl(correctedBlob).then((dataUrl) => {
          if (applyVersion !== this.gammaApplyVersion) return;
          this.editorImageBase64 = dataUrl;
          this.capturedImageSrc = dataUrl;
          this.croppedImageBlob = correctedBlob;
          this.croppedImageSrc = dataUrl;
          this.statusMessage = `Gamma applied (${this.gammaValue.toFixed(1)}).`;
        }).catch((e) => console.error('Failed to convert corrected blob to data URL:', e));
      })
      .catch((error) => {
        console.error('Gamma correction failed:', error);
      });
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to convert blob to data URL'));
      reader.readAsDataURL(blob);
    });
  }

 private applyGammaCorrection(imageBlob: Blob, gamma: number): Promise<Blob> {
  return new Promise((resolve, reject) => {

    const img = new Image();
    const url = URL.createObjectURL(imageBlob);

    img.onload = () => {

      URL.revokeObjectURL(url);

      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;

      const ctx = canvas.getContext('2d');
      if (!ctx) return reject('No canvas context');

      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      // LUT
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        lut[i] = Math.min(
  255,
  Math.max(
    0,
    Math.pow(i / 255, 1 / gamma) * 255
  )
);
      }

      // APPLY
      for (let i = 0; i < data.length; i += 4) {
        data[i]     = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
      }

      ctx.putImageData(imageData, 0, 0);

      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject('Blob failed');
      }, 'image/png');
    };

    img.onerror = () => reject('Image load failed');
    img.src = url;
  });
}
  validateForm(): boolean {
    this.formErrors = {};

    if (!this.uploadedFile) {
      this.formErrors['file'] = 'Please scan or select a document to upload.';
    }

    // if (!this.uniqueParcelId || this.uniqueParcelId.trim() === '') {
    //   this.formErrors['uniqueParcelId'] = 'Unique Parcel ID is required.';
    // }

    return Object.keys(this.formErrors).length === 0;
  }

  private buildAppRegId(): string {
    return `scan-${Date.now()}`;
  }

  showPreviousPreviewPage(): void {
    if (this.previewPageIndex > 0) {
      this.previewPageIndex--;
    }
  }

  showNextPreviewPage(): void {
    if (this.previewPageIndex < this.pagePreviewSources.length - 1) {
      this.previewPageIndex++;
    }
  }

  get currentPreviewSource(): string | null {
    return this.pagePreviewSources[this.previewPageIndex] || this.capturedImageSrc;
  }

  async uploadDocument(): Promise<void> {
    // SRS User Story 1: Metadata form is mandatory
    if (!this.validateForm()) {
      this.statusMessage = 'Please fill in all required fields.';
      return;
    }

    if (!this.uploadedFile) {
      this.statusMessage = 'No document to upload.';
      return;
    }

    const needsCollection = this.pagePreviewSources.length > 1 || this.editedBase64Images.length > 1;

    try {
      if (needsCollection) {
        this.isProcessingPdf = true;
        this.statusMessage = 'Collecting pages into PDF...';
        this.uploadedFile = await this.generateMultiPagePdf();
      }
    } catch (error: any) {
      this.isProcessingPdf = false;
      this.statusMessage = error?.message || 'Error generating PDF.';
      return;
    }

    this.isProcessingPdf = false;
    this.isUploading = true;
    this.statusMessage = 'Uploading document...';

    const formData = new FormData();
    formData.append('File', this.uploadedFile);
    formData.append('AppRegId', this.buildAppRegId());
    // formData.append('UniqueParcelId', this.uniqueParcelId.trim());
    formData.append('AdministrativeSourceTypeId', this.adminSourceTypeId.toString());

    this.documentService.uploadDocument(formData).subscribe({
      next: (response) => {
        console.log('Upload success', response);
        this.statusMessage = `Success! Document uploaded. Document ID: ${response.id}`;
        this.isUploading = false;
        this.resetForm();

        // Show success message for 3 seconds, then clear
        setTimeout(() => {
          if (this.statusMessage.includes('Success!')) {
            this.statusMessage = '';
          }
        }, 3000);
      },
      error: (err) => {
        console.error('Upload failed', err);
        this.isUploading = false;
        this.isProcessingPdf = false;

        let errorMessage = 'Upload failed. ';
        if (err.error) {
          if (err.error.errors && Array.isArray(err.error.errors)) {
            // Validation errors from API
            errorMessage = 'Validation errors: ' + err.error.errors.join(', ');
          } else if (typeof err.error === 'string') {
            errorMessage += err.error;
          } else if (err.error.message) {
            errorMessage += err.error.message;
          } else {
            errorMessage += JSON.stringify(err.error);
          }
        } else if (err.message) {
          errorMessage += err.message;
        } else {
          errorMessage += 'Unknown error. Please check console for details.';
        }
        this.statusMessage = errorMessage;
      }
    });
  }

  resetForm(): void {
    this.hasCapturedImage = false;
    this.isEditingImage = false;
    this.canvasRotation = 0;
    this.transform = {};
    this.gammaValue = 1.0;
    this.originalBlob = null;
    this.editorImageBase64 = null;
    this.croppedImageBlob = null;
    this.croppedImageSrc = null;
    this.capturedImageSrc = null;
    this.uploadedFile = null;
    this.formErrors = {};
    this.scannedImageCount = 0;
    this.currentEditingIndex = 0;
    this.editedBase64Images = [];
    this.previewPageIndex = 0;
    for (const source of this.pagePreviewSources) {
      if (source.startsWith('blob:')) {
        URL.revokeObjectURL(source);
      }
    }
    this.pagePreviewSources = [];
    if (this.DWTObject) {
       this.DWTObject.RemoveAllImages();
    }
    // Keep form fields for convenience (user might upload multiple documents)
  }
}
