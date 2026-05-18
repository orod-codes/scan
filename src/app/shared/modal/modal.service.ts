import { Injectable, Injector, ApplicationRef, createComponent, EmbeddedViewRef, EnvironmentInjector } from '@angular/core';
import { ModalComponent } from './modal.component';

export interface ModalOptions {
  title?: string;
  content?: string; // simple HTML content
}

@Injectable({ providedIn: 'root' })
export class ModalService {
  constructor(private injector: Injector, private appRef: ApplicationRef, private envInjector: EnvironmentInjector) {}

  open(options: ModalOptions = {}): Promise<void> {
    return new Promise((resolve) => {
      const compRef = createComponent(ModalComponent, { environmentInjector: this.envInjector });
      compRef.instance.title = options.title || '';
      compRef.instance.content = options.content || '';

      const subscription = compRef.instance.closed.subscribe(() => {
        this.appRef.detachView(compRef.hostView);
        compRef.destroy();
        subscription.unsubscribe();
        resolve();
      });

      this.appRef.attachView(compRef.hostView);
      const domElem = (compRef.hostView as EmbeddedViewRef<any>).rootNodes[0] as HTMLElement;
      document.body.appendChild(domElem);
    });
  }

  openComponent(component: any, options: ModalOptions = {}): Promise<void> {
    return new Promise((resolve) => {
      const modalRef = createComponent(ModalComponent, { environmentInjector: this.envInjector });
      modalRef.instance.title = options.title || '';

      const onClose = () => {
        try { this.appRef.detachView(childRef.hostView); } catch (e) {}
        try { childRef.destroy(); } catch (e) {}
        try { this.appRef.detachView(modalRef.hostView); } catch (e) {}
        try { modalRef.destroy(); } catch (e) {}
        resolve();
      };

      this.appRef.attachView(modalRef.hostView);
      const modalDom = (modalRef.hostView as EmbeddedViewRef<any>).rootNodes[0] as HTMLElement;
      document.body.appendChild(modalDom);

      const childRef = createComponent(component, { environmentInjector: this.envInjector });
      this.appRef.attachView(childRef.hostView);
      const childDom = (childRef.hostView as EmbeddedViewRef<any>).rootNodes[0] as HTMLElement;

      const bodyEl = modalDom.querySelector('.modal-body');
      if (bodyEl) {
        // Clear existing content then append
        bodyEl.innerHTML = '';
        bodyEl.appendChild(childDom);
      } else {
        modalDom.appendChild(childDom);
      }

      const subscription = modalRef.instance.closed.subscribe(() => {
        subscription.unsubscribe();
        onClose();
      });
    });
  }
}
