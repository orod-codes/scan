import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ModalService } from '../shared/modal/modal.service';

@Component({
  selector: 'app-popup-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './popup.component.html',
  styleUrls: ['./popup.component.css']
})
export class PopupComponent {
  constructor(private modal: ModalService) {}

  async openCard() {
    // Lazy-load the scan component and open it inside the modal as a card
    const mod = await import('../features/scanning/pages/scan/scan.component');
    await this.modal.openComponent(mod.ScanComponent, { title: 'Scanner' });
  }
}
