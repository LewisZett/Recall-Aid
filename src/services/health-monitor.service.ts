import { Injectable, signal, inject } from '@angular/core';
import { GeminiService } from './gemini.service';
import { AudioService } from './audio.service';
import { TtsService } from './tts.service';

@Injectable({
  providedIn: 'root'
})
export class HealthMonitorService {
  private geminiService = inject(GeminiService);
  private audioService = inject(AudioService);
  private ttsService = inject(TtsService);

  // Health State
  isSafeMode = signal(false);
  systemStatus = signal<'HEALTHY' | 'DEGRADED' | 'CRITICAL'>('HEALTHY');
  
  componentStatus = signal({
    camera: true,
    mic: true,
    ai: true,
    tts: true
  });
  
  lastSelfTestTime = signal<Date | null>(null);
  
  private heartbeatInterval: any;

  constructor() {
    this.startHeartbeat();
  }

  private startHeartbeat() {
    // Check vital signs every 60 seconds
    if (typeof window !== 'undefined') {
        this.heartbeatInterval = setInterval(() => this.runHeartbeat(), 60000);
    }
  }

  private async runHeartbeat() {
    // Silent check during operation
    const aiHealth = await this.geminiService.checkConnectivity();
    // For Mic, in background heartbeat, we only check if it *was* working if active
    const micHealth = this.audioService.checkHealth();
    
    // Only update mic status based on checkHealth if system is actually running
    // Otherwise we assume it's fine unless we prove otherwise
    if (this.audioService.checkHealth()) {
        this.updateStatus('mic', true);
    }
    
    this.updateStatus('ai', aiHealth);
    this.evaluateSystemState();
  }

  async runFullSelfTest(): Promise<string[]> {
    const report: string[] = [];
    
    // 1. Check TTS (including webkit prefix)
    const win = typeof window !== 'undefined' ? (window as any) : null;
    if (win && (win.speechSynthesis || win.webkitSpeechSynthesis)) {
      this.updateStatus('tts', true);
      report.push('TTS: OK (Available)');
    } else {
      this.updateStatus('tts', false);
      report.push('TTS: FAILED (API Missing)');
    }

    // 2. Check Mic Capability
    // We check API support. Checking actual stream health requires the system to be Active.
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
       this.updateStatus('mic', true);
       report.push('Microphone: OK (API Available)');
    } else {
       this.updateStatus('mic', false);
       report.push('Microphone: FAILED (API Missing)');
    }

    // 3. Check AI
    const aiHealth = await this.geminiService.checkConnectivity();
    this.updateStatus('ai', aiHealth);
    report.push(`AI Connection: ${aiHealth ? 'OK' : 'FAILED'}`);
    
    // 4. Camera is checked by App Component via reportError during operation
    // For diagnostic, we check API presence
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        this.updateStatus('camera', true);
        report.push('Camera: OK (API Available)');
    } else {
        this.updateStatus('camera', false);
        report.push('Camera: FAILED (API Missing)');
    }

    this.lastSelfTestTime.set(new Date());
    this.evaluateSystemState();
    
    return report;
  }

  reportError(component: 'camera' | 'mic' | 'ai' | 'tts') {
    console.warn(`HealthMonitor: Reported failure for ${component}`);
    this.updateStatus(component, false);
    this.evaluateSystemState();
  }
  
  reportRecovery(component: 'camera' | 'mic' | 'ai' | 'tts') {
      this.updateStatus(component, true);
      this.evaluateSystemState();
  }

  private updateStatus(component: 'camera' | 'mic' | 'ai' | 'tts', status: boolean) {
    this.componentStatus.update(current => ({
      ...current,
      [component]: status
    }));
  }

  private evaluateSystemState() {
    const s = this.componentStatus();
    
    if (!s.camera) {
      // If camera fails, automatic failover to "Safe Mode" (Text/Audio Only)
      this.isSafeMode.set(true);
      this.systemStatus.set('DEGRADED');
    } else if (!s.ai || !s.mic || !s.tts) { 
      // TTS, AI, or Mic missing means system is Degraded
      this.systemStatus.set('DEGRADED');
      this.isSafeMode.set(false);
    } else {
      this.systemStatus.set('HEALTHY');
      this.isSafeMode.set(false);
    }
    
    // Critical failure if both input sensors are dead
    if (!s.mic && !s.camera) {
       this.systemStatus.set('CRITICAL');
    }
  }
}