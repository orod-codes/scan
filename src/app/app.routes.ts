import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: '/scan',
    pathMatch: 'full'
  },
  {
    path: 'scan',
    loadComponent: () => import('./features/scanning/pages/scan/scan.component').then(m => m.ScanComponent)
  },
  {
    path: 'popup',
    loadComponent: () => import('./popup/popup.component').then(m => m.PopupComponent)
  },
  {
    path: '**',
    redirectTo: '/scan'
  }
];
