import { Injectable, signal, effect } from '@angular/core';

export interface CameraConfig {
  id: string;
  name: string;
  type: 'local' | 'ip';
  streamUrl?: string; 
}

@Injectable({ providedIn: 'root' })
export class PreferencesService {
  // 0.0 to 1.0 (Low to High Sensitivity)
  fallSensitivity = signal(0.8); 
  
  // 0.0 to 1.0 (Minimum confidence to trigger assistance)
  confusionThreshold = signal(0.6); 
  
  // Radius in meters
  geofenceRadius = signal(100); 

  // External Cameras
  savedCameras = signal<CameraConfig[]>([]);

  constructor() {
    this.loadCameras();
    
    // Auto-save when cameras change
    effect(() => {
        const cams = this.savedCameras();
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('recall_aid_cameras', JSON.stringify(cams));
        }
    });
  }

  private loadCameras() {
    if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('recall_aid_cameras');
        if (raw) {
            try {
                this.savedCameras.set(JSON.parse(raw));
            } catch {
                this.savedCameras.set([]);
            }
        }
    }
  }
}