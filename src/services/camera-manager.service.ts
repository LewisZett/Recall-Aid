
import { Injectable, signal, computed, inject } from '@angular/core';
import { PreferencesService, CameraConfig } from './preferences.service';

@Injectable({
  providedIn: 'root'
})
export class CameraManagerService {
  private prefs = inject(PreferencesService);

  // State
  activeCameraIndex = signal(0);
  isScanning = signal(false);
  isPatrolEnabled = signal(false); // New: Auto-cycle cameras
  
  // Combine Local + External
  allCameras = computed(() => {
    const local: CameraConfig = { id: 'local-001', name: 'Device Camera', type: 'local' };
    return [local, ...this.prefs.savedCameras()];
  });

  activeCamera = computed(() => {
    const cams = this.allCameras();
    return cams[this.activeCameraIndex()] || cams[0];
  });

  addCamera(name: string, url: string) {
    const newCam: CameraConfig = {
      id: Math.random().toString(36).substring(7),
      name,
      type: 'ip',
      streamUrl: url
    };
    this.prefs.savedCameras.update(current => [...current, newCam]);
  }

  removeCamera(id: string) {
    this.prefs.savedCameras.update(current => current.filter(c => c.id !== id));
    // Reset to local if we deleted the active one
    if (this.activeCameraIndex() >= this.allCameras().length) {
      this.activeCameraIndex.set(0);
    }
  }

  nextCamera() {
    const next = (this.activeCameraIndex() + 1) % this.allCameras().length;
    this.activeCameraIndex.set(next);
  }

  prevCamera() {
    const len = this.allCameras().length;
    const prev = (this.activeCameraIndex() - 1 + len) % len;
    this.activeCameraIndex.set(prev);
  }
  
  togglePatrol() {
    this.isPatrolEnabled.update(v => !v);
  }

  // Simulate scanning for devices broadcasting an AP (Access Point)
  async scanForApDevices(): Promise<{id: string, ssid: string} | null> {
    this.isScanning.set(true);
    // Simulate network scan delay
    await new Promise(resolve => setTimeout(resolve, 2500));
    this.isScanning.set(false);

    // 80% chance to find a device for demo purposes
    if (Math.random() > 0.2) {
       const id = Math.random().toString(36).substring(2, 6).toUpperCase();
       return {
         id: id,
         ssid: `CAM_SETUP_${id}`
       };
    }
    return null;
  }

  // Simulate sending Wi-Fi credentials to the discovered device
  async provisionCamera(deviceId: string, ssid: string, pass: string): Promise<CameraConfig> {
    // 1. Handshake
    console.log(`[CameraManager] Handshake with device ${deviceId}...`);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. Sending Credentials
    console.log(`[CameraManager] Sending credentials to ${deviceId}...`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // 3. Device Reboot & Connect Delay
    console.log(`[CameraManager] Waiting for device to join local network...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Create new IP camera config simulating the now-connected device
    const newCam: CameraConfig = {
      id: deviceId,
      name: `Wifi Cam ${deviceId.substring(0, 4)}`,
      type: 'ip',
      streamUrl: `https://picsum.photos/640/480?random=${deviceId}`
    };

    // Save to preferences
    this.prefs.savedCameras.update(current => [...current, newCam]);
    
    return newCam;
  }
}
