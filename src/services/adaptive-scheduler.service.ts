import { Injectable, signal } from '@angular/core';
import { LIFE_LOG } from './lifelog.data';

@Injectable({
  providedIn: 'root'
})
export class AdaptiveSchedulerService {
  // Public Signals for UI
  statusMessage = signal<string>('Standard Monitor');
  batteryLevel = signal<number | null>(null);
  isLowPowerMode = signal(false);
  networkStatus = signal<'online' | 'offline' | 'slow'>('online');
  networkType = signal<string>('4g');

  private lastActivityTime = Date.now();
  private battery: any = null;
  private connection: any = null;

  constructor() {
    this.initSensors();
  }

  private async initSensors() {
    // Battery API
    if (typeof navigator !== 'undefined' && (navigator as any).getBattery) {
      try {
        this.battery = await (navigator as any).getBattery();
        this.updateBatteryStatus();
        this.battery.addEventListener('levelchange', () => this.updateBatteryStatus());
        this.battery.addEventListener('chargingchange', () => this.updateBatteryStatus());
      } catch (e) {
        console.warn('Battery API not supported');
      }
    }

    // Network API
    if (typeof navigator !== 'undefined') {
        window.addEventListener('online', () => this.updateNetworkStatus());
        window.addEventListener('offline', () => this.updateNetworkStatus());
        
        if ((navigator as any).connection) {
            this.connection = (navigator as any).connection;
            this.connection.addEventListener('change', () => this.updateNetworkStatus());
        }
        this.updateNetworkStatus();
    }
  }

  private updateBatteryStatus() {
    if (!this.battery) return;
    this.batteryLevel.set(Math.round(this.battery.level * 100));
    // Low power if under 20% and NOT charging
    this.isLowPowerMode.set(this.battery.level < 0.2 && !this.battery.charging);
  }

  private updateNetworkStatus() {
      if (!navigator.onLine) {
          this.networkStatus.set('offline');
          return;
      }
      
      if (this.connection) {
          this.networkType.set(this.connection.effectiveType);
          if (this.connection.effectiveType === 'slow-2g' || this.connection.effectiveType === '2g') {
              this.networkStatus.set('slow');
          } else {
              this.networkStatus.set('online');
          }
      } else {
          this.networkStatus.set('online');
      }
  }

  recordActivity() {
    this.lastActivityTime = Date.now();
  }

  calculateNextInterval(): number {
    const now = new Date();
    let interval = 8000; // Base: 8 seconds
    let reasons: string[] = [];

    // 1. Critical Time Windows (Medication/Routine) - Priority High
    // Check if we are within +/- 30 mins of a scheduled event
    const isCriticalTime = this.checkCriticalTime(now);
    if (isCriticalTime) {
      interval = 3000; // Fast polling
      reasons.push('Critical Window');
    }

    // 2. Idle Backoff (Only if NOT critical time)
    if (!isCriticalTime) {
      const msSinceActivity = now.getTime() - this.lastActivityTime;
      const minutesIdle = msSinceActivity / 60000;

      if (minutesIdle > 5) {
        // Linear backoff: add 5 seconds for every 5 mins idle, capped at 30s
        const backoff = Math.min(22000, Math.floor((minutesIdle / 5) * 5000));
        interval += backoff;
        reasons.push(`Idle (${Math.round(minutesIdle)}m)`);
      }
    }

    // 3. Resource Throttling (Multipliers)
    
    // Battery
    if (this.isLowPowerMode()) {
      interval = Math.floor(interval * 2);
      reasons.push('Low Battery');
    }

    // Network
    if (this.networkStatus() === 'slow') {
        interval = Math.floor(interval * 1.5);
        reasons.push('Weak Signal');
    }
    
    if (this.connection && this.connection.saveData) {
        interval = Math.floor(interval * 1.5);
        reasons.push('Data Saver');
    }

    // 4. Update Status UI
    if (reasons.length === 0) {
      this.statusMessage.set('Standard Monitor');
    } else {
      this.statusMessage.set(reasons.join(' • '));
    }

    return interval;
  }

  private checkCriticalTime(now: Date): boolean {
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    const allEvents = [
      ...LIFE_LOG.medication_reminders,
      ...LIFE_LOG.daily_routine
    ];

    return allEvents.some(event => {
      const [h, m] = event.time.split(':').map(Number);
      const eventMinutes = h * 60 + m;
      const diff = Math.abs(currentMinutes - eventMinutes);
      return diff <= 30; // Within 30 minutes
    });
  }
}