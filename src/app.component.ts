
import { Component, ViewChild, ElementRef, signal, computed, effect, inject, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GeminiService, ObservationResult } from './services/gemini.service';
import { TtsService } from './services/tts.service';
import { VoiceInputService } from './services/voice-input.service';
import { AudioService } from './services/audio.service';
import { AdaptiveSchedulerService } from './services/adaptive-scheduler.service';
import { MemoryService } from './services/memory.service';
import { HealthMonitorService } from './services/health-monitor.service';
import { LocationService } from './services/location.service';
import { PreferencesService } from './services/preferences.service';
import { FaceBlurService } from './services/face-blur.service';
import { CameraManagerService } from './services/camera-manager.service';
import { LIFE_LOG } from './services/lifelog.data';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrls: []
})
export class AppComponent {
  private geminiService = inject(GeminiService);
  public ttsService = inject(TtsService); 
  public voiceService = inject(VoiceInputService);
  public audioService = inject(AudioService); 
  public scheduler = inject(AdaptiveSchedulerService);
  public memoryService = inject(MemoryService);
  public healthService = inject(HealthMonitorService);
  public locationService = inject(LocationService);
  public prefsService = inject(PreferencesService);
  public faceBlurService = inject(FaceBlurService);
  public cameraManager = inject(CameraManagerService);
  
  private destroyRef = inject(DestroyRef);

  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasElement') canvasElement!: ElementRef<HTMLCanvasElement>;
  @ViewChild('ipCameraImage') ipCameraImage!: ElementRef<HTMLImageElement>;

  // State Signals
  isActive = signal(false);
  isObserving = signal(false);
  isReasoning = signal(false);
  isLoopPaused = signal(false); 
  lastCheckInTime = signal<Date | null>(null);
  
  // Nudge & Feedback
  lastNudge = signal<string | null>(null);
  feedbackState = signal<'none' | 'positive' | 'negative'>('none');

  // Views & UI State
  isSettingsOpen = signal(false);
  isDashboardOpen = signal(false);
  isCaregiverMode = signal(false); 
  isPrivacyMode = signal(false); 
  
  // Camera Setup State
  cameraSetupMode = signal<'manual' | 'ap'>('manual');
  discoveredApDevice = signal<{id: string, ssid: string} | null>(null);
  isProvisioning = signal(false);

  // Reports
  generatedReport = signal<string | null>(null);
  isGeneratingReport = signal(false);
  
  // Diagnostics UI State
  isRunningDiagnostics = signal(false);
  diagnosticResults = signal<string[] | null>(null);
  
  // Emergency System State
  emergencyLevel = signal<0 | 1 | 2 | 3>(0);
  emergencyCountdown = signal(10);
  emergencyReason = signal<string>('');
  
  // Multi-modal Cue Accumulation
  recentCues = signal<Set<'visual' | 'audio'>>(new Set());
  private cueTimeout: any;
  
  // Dynamic Loop State
  loopIntervalMs = signal(8000); 
  
  // Logs for HUD
  logs = signal<{time: string, type: 'observer' | 'reasoner' | 'system' | 'voice', message: string}[]>([]);
  
  // Observation State
  currentObservation = signal<ObservationResult | null>(null);
  confidenceLevel = computed(() => {
    const obs = this.currentObservation();
    return obs ? Math.round(obs.confidence * 100) : 0;
  });

  // Visual Diff State
  private previousFrameData: Uint8ClampedArray | null = null;
  visualChangePercent = signal(0);
  
  // Safe Mode Computed
  isSafeMode = computed(() => this.healthService.isSafeMode());

  private loopTimeout: any;
  private emergencyTimer: any;

  constructor() {
    // Run initial self-test on startup
    setTimeout(() => this.runSelfTest(true), 1000);

    // Handle Page Visibility
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.addLog('system', 'App backgrounded. Pausing sensors.');
          this.stopLoop();
          this.stopCamera();
        } else if (this.isActive() && !this.isPrivacyMode() && !this.isSafeMode()) {
          this.addLog('system', 'App foregrounded. Resuming sensors.');
          this.startCamera();
          this.startLoop();
        }
      });
    }

    // Effect: Handle Active State
    effect(() => {
      if (this.isActive()) {
        if (!this.isPrivacyMode() && !this.isSafeMode()) {
          this.startCamera();
        }
        this.isLoopPaused.set(false);
        this.startLoop();
      } else {
        this.stopCamera();
        this.stopLoop();
        this.audioService.cleanup();
      }
    });
    
    // Effect: Geofence Monitoring
    effect(() => {
        if (this.isActive() && this.locationService.isOutsideGeofence()) {
            this.addLog('system', `Geofence Breach: ${this.locationService.distanceFromHome()}m away`);
            if (this.emergencyLevel() === 0) {
                this.triggerEmergency(1, 'User left safe zone');
            }
        }
    });

    // Effect: Handle Privacy Mode or Safe Mode
    effect(() => {
      if (this.isPrivacyMode() || this.isSafeMode()) {
        this.stopCamera();
        if (this.isSafeMode()) {
            this.addLog('system', 'Entering Safe Mode (Camera Unavailable)');
        } else {
            this.addLog('system', 'Privacy Mode: Camera & Analysis Halted.');
            // Clear temporary buffers to ensure privacy
            this.audioService.cleanup();
        }
      } else if (this.isActive()) {
        this.startCamera();
        this.addLog('system', 'Camera Active. Face Blurring Enabled.');
      }
    });

    // React to voice transcripts
    effect(() => {
      const transcript = this.voiceService.transcript();
      if (transcript) {
        this.scheduler.recordActivity(); 
        this.handleVoiceTranscript(transcript);
        this.memoryService.addEvent('user_voice', transcript);
        
        // If voice says "Help", treat as Audio Cue
        if (transcript.toLowerCase().includes('help')) {
           this.accumulateCues(['audio']);
        }
      }
    });

    this.destroyRef.onDestroy(() => {
      this.stopCamera();
      this.stopLoop();
      this.audioService.cleanup();
      this.locationService.cleanup();
      this.clearEmergencyTimer();
      if (this.cueTimeout) clearTimeout(this.cueTimeout);
    });
  }

  async runSelfTest(isStartup = false) {
      if (!isStartup) {
        this.isRunningDiagnostics.set(true);
        this.diagnosticResults.set(null);
      }
      
      this.addLog('system', 'Running System Self-Test...');
      
      try {
        const results = await this.healthService.runFullSelfTest();
        results.forEach(r => this.addLog('system', r));
        
        if (!isStartup) {
            this.diagnosticResults.set(results);
        }

        if (this.healthService.systemStatus() === 'HEALTHY') {
            this.ttsService.speak('System check passed.');
        } else {
            this.ttsService.speak('System check failed. Some features may be limited.');
        }
      } catch (e) {
         console.error(e);
         if (!isStartup) this.diagnosticResults.set(['Diagnostic Error']);
      } finally {
         this.isRunningDiagnostics.set(false);
      }
  }
  
  async generateReport() {
      this.isGeneratingReport.set(true);
      const logs = this.memoryService.getSessionHistory().map(h => 
          `[${new Date(h.timestamp).toLocaleTimeString()}] ${h.type}: ${h.content}`
      );
      const report = await this.geminiService.generateActivityReport(logs);
      this.generatedReport.set(report);
      this.isGeneratingReport.set(false);
  }

  toggleSystem() {
    if (this.emergencyLevel() > 0) {
      this.cancelEmergency();
      return;
    }
    this.isActive.update(v => !v);
    this.addLog('system', this.isActive() ? 'System Activated' : 'System Deactivated');
    if (!this.isActive()) {
      this.ttsService.stop();
    }
  }

  toggleSettings() {
    this.isSettingsOpen.update(v => !v);
    if (this.isSettingsOpen()) {
        this.isDashboardOpen.set(false);
        this.isCaregiverMode.set(false);
    }
  }

  toggleDashboard() {
    this.isDashboardOpen.update(v => !v);
    if (this.isDashboardOpen()) {
        this.isSettingsOpen.set(false);
        this.isCaregiverMode.set(false);
    }
  }
  
  toggleCaregiverMode() {
      this.isCaregiverMode.update(v => !v);
      if (this.isCaregiverMode()) {
          this.isSettingsOpen.set(false);
          this.isDashboardOpen.set(false);
      }
  }

  togglePrivacy() {
    this.isPrivacyMode.update(v => !v);
  }

  provideFeedback(type: 'positive' | 'negative') {
    this.feedbackState.set(type);
    this.addLog('system', `User Feedback: ${type.toUpperCase()}`);
    this.scheduler.recordActivity();
    
    if (this.lastNudge()) {
      this.memoryService.learnFromFeedback(this.lastNudge()!, type === 'positive');
    }

    setTimeout(() => {
      this.lastNudge.set(null); 
      this.feedbackState.set('none');
    }, 1500);
  }

  toggleVoice() {
    this.scheduler.recordActivity();
    if (this.emergencyLevel() > 0) return; 

    // UX: If system is offline, the main button acts as a Power On button
    if (!this.isActive()) {
      this.toggleSystem();
      this.ttsService.speak("System online.");
      return;
    }

    if (this.voiceService.isProcessing()) return; 

    if (this.voiceService.isListening()) {
      this.voiceService.stop();
    } else {
      this.ttsService.stop(); 
      this.voiceService.start();
    }
  }

  async handleVoiceTranscript(fullText: string) {
    this.addLog('voice', `Heard: "${fullText}"`);
    this.voiceService.transcript.set(''); 

    // VOICE FINGERPRINT CHECK
    if (!this.audioService.isVoiceMatch()) {
      this.addLog('system', 'Voice Mismatch (Visitor Detected).');
      this.ttsService.speak("Voice not recognized. Proceeding with caution.");
      // In a real app, we might block certain commands here
    }

    // COMMAND CHAINING PARSER
    const commands = this.voiceService.parseCommands(fullText);

    // Execute Sequentially
    for (const cmd of commands) {
      await this.executeSingleCommand(cmd.command, cmd.text);
    }
  }

  async executeSingleCommand(command: 'ACTIVATE' | 'DEACTIVATE' | 'PAUSE' | 'RESUME' | 'EMERGENCY' | 'QUERY' | null, text: string) {
    
    switch (command) {
      case 'EMERGENCY':
        this.triggerEmergency(2, 'User requested help via voice');
        break;

      case 'ACTIVATE':
        if (!this.isActive()) {
          this.isActive.set(true);
          this.ttsService.speak("System activated.");
        }
        break;

      case 'DEACTIVATE':
        if (this.isActive()) {
          this.isActive.set(false);
          this.ttsService.speak("Deactivating system.");
        }
        break;

      case 'PAUSE':
        if (this.isActive() && !this.isLoopPaused()) {
          this.stopLoop();
          this.isLoopPaused.set(true);
          this.addLog('system', 'Paused via Voice');
          this.ttsService.speak("Paused.");
        }
        break;

      case 'RESUME':
        if (this.isActive() && this.isLoopPaused()) {
          this.isLoopPaused.set(false);
          this.startLoop();
          this.addLog('system', 'Resumed');
          this.ttsService.speak("Resuming.");
        }
        break;

      default: // QUERY
        // Check for safe words during soft emergency
        if (this.emergencyLevel() === 1) {
           if (text.toLowerCase().includes('yes') || text.toLowerCase().includes('okay')) {
             this.ttsService.speak("Okay. Let me know if you need help.");
             this.cancelEmergency();
             return;
           }
        }

        if (!this.isActive()) {
          // If query passed but system inactive (likely wake word from cold start)
          this.ttsService.speak("System is offline. Say Activate.");
          return;
        }
        
        if (this.isPrivacyMode()) {
           this.ttsService.speak("Privacy mode is on.");
           return;
        }
        
        // SAFE MODE CHECK FOR QUERIES
        let frame: string | null = null;
        if (!this.isSafeMode()) {
            frame = await this.captureFrame();
        }
        
        if (this.isSafeMode() && !frame) {
            this.ttsService.speak("Camera unavailable. I will try to answer based on text.");
            frame = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"; // 1x1 pixel gif
        }

        if (frame !== null) {
            this.triggerReasoning(frame, text, 'question');
        }
        break;
    }
  }

  // --- MULTI-MODAL EMERGENCY SYSTEM ---

  accumulateCues(newCues: ('visual' | 'audio')[]) {
    const current = this.recentCues();
    newCues.forEach(c => current.add(c));
    this.recentCues.set(new Set(current));

    if (this.cueTimeout) clearTimeout(this.cueTimeout);
    this.cueTimeout = setTimeout(() => {
      this.recentCues.set(new Set());
    }, 30000);
  }

  triggerEmergency(level: 1 | 2 | 3, reason: string) {
    if (this.emergencyLevel() >= level) return; 
    if (this.isSettingsOpen()) this.isSettingsOpen.set(false);
    if (this.isDashboardOpen()) this.isDashboardOpen.set(false);

    this.emergencyLevel.set(level);
    this.emergencyReason.set(reason);
    this.stopLoop();
    this.scheduler.recordActivity();
    
    this.addLog('system', `ALERT LEVEL ${level}: ${reason}`);
    this.memoryService.addEvent('action', `ALERT LVL ${level}: ${reason}`);
    
    const caregiver = LIFE_LOG.social_circle.find(p => p.relationship === 'Caregiver') || LIFE_LOG.social_circle[0];

    if (level === 1) {
      this.ttsService.speak("I noticed you seem distressed. Are you okay?");
      setTimeout(() => this.voiceService.start(), 4000);
      
      this.emergencyTimer = setTimeout(() => {
         if (this.emergencyLevel() === 1) this.cancelEmergency();
      }, 60000);

    } else if (level === 2) {
      this.emergencyCountdown.set(15);
      this.ttsService.speak(`Concern detected. Contacting ${caregiver.name} in 15 seconds.`);
      this.startCountdown(caregiver.name, caregiver.phone);

    } else if (level === 3) {
      this.emergencyCountdown.set(10);
      this.ttsService.speak(`Emergency detected. Contacting Emergency Services.`);
      this.startCountdown('911', '911');
    }
  }

  startCountdown(contactName: string, phoneNumber?: string) {
    this.clearEmergencyTimer();
    this.emergencyTimer = setInterval(() => {
      const current = this.emergencyCountdown();
      if (current > 1) {
        this.emergencyCountdown.set(current - 1);
      } else {
        this.executeEmergencyCall(contactName, phoneNumber);
      }
    }, 1000);
  }

  cancelEmergency() {
    this.clearEmergencyTimer();
    this.emergencyLevel.set(0);
    this.emergencyReason.set('');
    this.recentCues.set(new Set()); 
    this.ttsService.speak("Cancelled.");
    this.addLog('system', 'Alert cancelled.');
    this.memoryService.addEvent('action', 'Alert Cancelled by User');
    this.startLoop(); 
  }

  private executeEmergencyCall(contactName: string, phoneNumber?: string) {
    this.clearEmergencyTimer();
    this.emergencyCountdown.set(0);
    this.addLog('system', `CALLING ${contactName} (${phoneNumber})...`);
    this.ttsService.speak(`Calling ${contactName}.`);
    // In a real app, this would use window.open(`tel:${phoneNumber}`)
  }
  
  private clearEmergencyTimer() {
    if (this.emergencyTimer) {
      clearInterval(this.emergencyTimer);
      clearTimeout(this.emergencyTimer);
      this.emergencyTimer = null;
    }
  }

  // --- CAMERA SETUP & PROVISIONING ---
  
  addCamera(name: string, url: string) {
    if (name && url) {
        this.cameraManager.addCamera(name, url);
        this.addLog('system', `Added Camera: ${name}`);
    }
  }
  
  async scanForCamera() {
      this.addLog('system', 'Scanning for AP Devices...');
      const device = await this.cameraManager.scanForApDevices();
      if (device) {
          this.discoveredApDevice.set(device);
          this.addLog('system', `Found Device: ${device.ssid}`);
          this.ttsService.speak("Device found. Please enter Wi-Fi credentials.");
      } else {
          this.addLog('system', 'No devices found.');
          this.ttsService.speak("No devices found. Please try again.");
      }
  }

  async provisionDevice(ssid: string, pass: string) {
      const device = this.discoveredApDevice();
      if (!device) return;
      
      if (!ssid || pass.length < 8) {
          this.addLog('system', 'Provision Error: Invalid credentials');
          this.ttsService.speak("Please check the password.");
          return;
      }

      this.isProvisioning.set(true);
      this.addLog('system', `Provisioning ${device.ssid}...`);
      
      try {
          const newCam = await this.cameraManager.provisionCamera(device.id, ssid, pass);
          this.addLog('system', 'Provisioning Success');
          this.ttsService.speak("Camera connected successfully.");
          
          // Reset UI
          this.discoveredApDevice.set(null);
          this.cameraSetupMode.set('manual');
          this.toggleSettings(); // Close settings to show dashboard/feed
      } catch (e) {
          this.addLog('system', 'Provisioning Failed');
          this.ttsService.speak("Connection failed.");
      } finally {
          this.isProvisioning.set(false);
      }
  }

  // --- MAIN AGENTIC LOOP ---

  startLoop() {
    this.stopLoop();
    if (this.isPrivacyMode() || this.emergencyLevel() > 0 || this.isLoopPaused() || !this.isActive()) return;
    
    // Calculate adaptive interval
    const interval = this.scheduler.calculateNextInterval();
    this.loopIntervalMs.set(interval);
    
    // Schedule next iteration
    this.loopTimeout = setTimeout(() => this.processLoop(), interval);
  }

  stopLoop() {
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
      this.loopTimeout = null;
    }
    this.isObserving.set(false);
  }

  async processLoop() {
    if (!this.isActive() || this.isLoopPaused() || this.emergencyLevel() > 0) return;

    this.isObserving.set(true);
    this.lastCheckInTime.set(new Date());

    try {
      // 1. Capture Data
      const frame = await this.captureFrame();
      const audio = await this.audioService.getAudioSegment();
      
      if (!frame && !this.isSafeMode()) {
         // Camera failure detected during loop
         this.healthService.reportError('camera');
         this.startLoop(); // Retry (will adapt to Safe Mode if persistent)
         return;
      }
      
      // If Safe Mode, we only use Audio
      const visualScore = this.isSafeMode() ? 0 : this.visualChangePercent();
      
      // 2. Observe (Agent 1)
      // If in safe mode, we pass a dummy black frame
      const effectiveFrame = frame || "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      
      const result = await this.geminiService.observeEnvironment(
         effectiveFrame, 
         audio,
         visualScore
      );

      this.currentObservation.set(result);
      this.addLog('observer', `[${result.confidence.toFixed(2)}] ${result.observation}`);

      // 3. Evaluate & Act
      if (result.isPrivacyZone) {
         if (!this.isPrivacyMode()) {
             this.addLog('system', 'Privacy Zone Detected. Disabling Camera.');
             this.ttsService.speak("Entering privacy zone. Camera off.");
             this.togglePrivacy();
         }
      }

      if (result.needsAssistance && result.confidence > this.prefsService.confusionThreshold()) {
        
        if (result.emergencyLevel === 'CRITICAL') {
           // Immediate visual verification or fallback
           this.triggerEmergency(3, result.observation);
        
        } else if (result.emergencyLevel === 'SOFT') {
           this.triggerEmergency(1, result.observation);
        
        } else {
           // General Assistance / Nudge
           await this.triggerReasoning(effectiveFrame, result.observation, 'observation');
        }
      }

    } catch (e) {
      console.error('Loop Error', e);
    } finally {
      this.isObserving.set(false);
      this.startLoop(); // Recursive loop
    }
  }

  async triggerReasoning(frame: string, context: string, mode: 'observation' | 'question') {
      this.isReasoning.set(true);
      try {
          const assistance = await this.geminiService.reasonAndAssist(frame, context, mode);
          this.addLog('reasoner', `"${assistance}"`);
          
          // Speak the result
          if (mode === 'question' || (assistance && assistance.length > 5)) {
             this.lastNudge.set(assistance);
             this.ttsService.speak(assistance);
          }
      } catch(e) {
          this.addLog('system', 'Reasoner Busy/Error');
      } finally {
          this.isReasoning.set(false);
      }
  }

  // --- HARDWARE ABSTRACTION ---

  async startCamera() {
    if (this.isSafeMode()) return;
    
    // Check which camera to use
    const camConfig = this.cameraManager.activeCamera();
    
    // If external IP camera, we don't use navigator.getUserMedia
    if (camConfig.type === 'ip') {
        // IP Cam logic is handled in template via <img> tag
        this.addLog('system', `Switched to ${camConfig.name}`);
        return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: true 
      });
      
      if (this.videoElement) {
        this.videoElement.nativeElement.srcObject = stream;
        // Wait for metadata to load to prevent 0x0 canvas issues
        this.videoElement.nativeElement.onloadedmetadata = () => {
           this.healthService.reportRecovery('camera');
        };
      }
      
      // Init Audio Service with the stream
      await this.audioService.initialize(stream);
      
    } catch (e) {
      console.error('Camera Start Failed', e);
      this.healthService.reportError('camera');
      this.healthService.reportError('mic');
    }
  }

  stopCamera() {
    if (this.videoElement && this.videoElement.nativeElement.srcObject) {
      const stream = this.videoElement.nativeElement.srcObject as MediaStream;
      stream.getTracks().forEach(t => t.stop());
      this.videoElement.nativeElement.srcObject = null;
    }
  }
  
  handleCameraError() {
      // Called by template (img error) or logic
      this.addLog('system', 'Camera Feed Failed');
      this.healthService.reportError('camera');
  }

  async captureFrame(): Promise<string | null> {
    const camConfig = this.cameraManager.activeCamera();

    // 1. IP Camera Capture (via Canvas proxy)
    if (camConfig.type === 'ip') {
        if (!this.ipCameraImage || !this.canvasElement) return null;
        const img = this.ipCameraImage.nativeElement;
        const canvas = this.canvasElement.nativeElement;
        
        if (!img.complete || img.naturalWidth === 0) return null;
        
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        
        try {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            // We assume IP cams in private homes don't need blurring *on device*, 
            // but for consistency we could run it. 
            // Let's run it if we have time budget? No, expensive.
            return canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
        } catch(e) {
            // CORS issue likely
            return null;
        }
    }

    // 2. Local Camera Capture
    if (!this.videoElement || !this.canvasElement) return null;
    const video = this.videoElement.nativeElement;
    const canvas = this.canvasElement.nativeElement;

    if (video.readyState !== 4) return null;

    canvas.width = 640;
    canvas.height = 480;

    // Detect Motion (Pixel Diff)
    this.detectMotion(video, canvas);

    // Apply Privacy Filter (Face Blur)
    try {
        const processedBase64 = await this.faceBlurService.processFrame(video, canvas);
        return processedBase64;
    } catch (e) {
        // Fallback if blur fails? For safety, we return null or black frame?
        // Let's return low-res unblurred if service fails but system healthy
        return null;
    }
  }

  private detectMotion(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    
    // Draw small for diffing
    const smallW = 64;
    const smallH = 48;
    ctx.drawImage(video, 0, 0, smallW, smallH);
    const frameData = ctx.getImageData(0, 0, smallW, smallH).data;
    
    if (this.previousFrameData) {
      let diff = 0;
      for (let i = 0; i < frameData.length; i += 4) {
        diff += Math.abs(frameData[i] - this.previousFrameData[i]);
      }
      const score = Math.min(100, Math.round(diff / (smallW * smallH)));
      this.visualChangePercent.set(score);
    }
    this.previousFrameData = frameData;
  }

  // --- UTILS ---
  
  getLifeLogPreview() {
    return LIFE_LOG;
  }

  addLog(type: 'observer' | 'reasoner' | 'system' | 'voice', message: string) {
    const now = new Date().toLocaleTimeString([], { hour12: false });
    this.logs.update(current => [{ time: now, type, message }, ...current].slice(0, 50));
  }
}
