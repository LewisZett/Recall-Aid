import { Injectable, signal, effect, inject } from '@angular/core';
import { LIFE_LOG } from './lifelog.data';
import { PreferencesService } from './preferences.service';

@Injectable({ providedIn: 'root' })
export class LocationService {
  currentLocation = signal<{lat: number, lng: number} | null>(null);
  distanceFromHome = signal<number>(0);
  isOutsideGeofence = signal(false);
  locationError = signal<string | null>(null);
  
  private prefs = inject(PreferencesService);
  private watchId: number | null = null;

  constructor() {
    this.startTracking();
  }

  startTracking() {
    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.updatePosition(pos),
        (err) => {
          console.warn('Location Service Error:', err.message);
          this.locationError.set('GPS Signal Lost');
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    } else {
      this.locationError.set('Geolocation not supported');
    }
  }

  private updatePosition(pos: GeolocationPosition) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    this.currentLocation.set({ lat, lng });

    const home = LIFE_LOG.user_profile.home_coordinates;
    const dist = this.calculateDistance(lat, lng, home.lat, home.lng);
    this.distanceFromHome.set(Math.round(dist));

    // Simple hysteresis: require moving 10m past boundary to trigger, 10m inside to clear
    // to prevent flip-flopping at the edge.
    const radius = this.prefs.geofenceRadius();
    if (!this.isOutsideGeofence() && dist > radius + 10) {
        this.isOutsideGeofence.set(true);
    } else if (this.isOutsideGeofence() && dist < radius - 10) {
        this.isOutsideGeofence.set(false);
    }
    
    this.locationError.set(null);
  }

  // Haversine formula
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
  }
  
  cleanup() {
      if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
  }
}