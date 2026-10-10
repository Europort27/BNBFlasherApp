import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCable, lucideCircleAlert, lucideCpu, lucideRadio, lucideUsb } from '@ng-icons/lucide';
import { Component } from '@angular/core';

@Component({
  selector: 'app-hardware-page',
  imports: [NgIcon],
  providers: [provideIcons({ lucideCable, lucideCircleAlert, lucideCpu, lucideRadio, lucideUsb })],
  templateUrl: './hardware.html',
})
export class HardwarePage {}