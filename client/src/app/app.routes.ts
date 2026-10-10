import { Routes } from '@angular/router';
import { FlasherPage } from './app';
import { HardwarePage } from './hardware';
import { InstructionsPage } from './instructions';

export const routes: Routes = [
  { path: '', component: FlasherPage, title: 'BNB / Flash' },
  { path: 'instructions', component: InstructionsPage, title: 'Instructions · BNB / Flash' },
  { path: 'hardware', component: HardwarePage, title: 'Hardware · BNB / Flash' },
  { path: '**', redirectTo: '' },
];