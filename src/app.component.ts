import { Component, ViewChild, ElementRef, signal, computed, effect, inject, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GeminiService, ObservationResult } from './services/gemini.service';
import { TtsService } from './services/tts.service';
import { VoiceInputService } from './services/voice-input.service';
import { AudioService } from './services/audio.service';
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
  private destroyRef = inject(DestroyRef);

  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasElement') canvasElement!: ElementRef<HTMLCanvasElement>;

  // State Signals
  isActive = signal(false);
  isObserving = signal(false);
  isReasoning = signal(false);
  isLoopPaused = signal(false); 
  lastNudge = signal<string | null>(null);
  
  // Dynamic Loop State
  loopIntervalMs = signal(8000); 
  
  // Logs for UI
  logs = signal<{time: string, type: 'observer' | 'reasoner' | 'system' | 'voice', message: string}[]>([]);
  
  // Observation State
  currentObservation = signal<ObservationResult | null>(null);
  confidenceLevel = computed(() => {
    const obs = this.currentObservation();
    return obs ? Math.round(obs.confidence * 100) : 0;
  });

  private loopTimeout: any;

  constructor() {
    effect(() => {
      if (this.isActive()) {
        this.startCamera();
        this.isLoopPaused.set(false);
        this.startLoop();
      } else {
        this.stopCamera();
        this.stopLoop();
        this.audioService.cleanup();
      }
    });

    // React to voice transcripts
    effect(() => {
      const transcript = this.voiceService.transcript();
      if (transcript) {
        this.handleVoiceCommand(transcript);
      }
    });

    this.destroyRef.onDestroy(() => {
      this.stopCamera();
      this.stopLoop();
      this.audioService.cleanup();
    });
  }

  toggleSystem() {
    this.isActive.update(v => !v);
    this.addLog('system', this.isActive() ? 'System Activated' : 'System Deactivated');
    if (!this.isActive()) {
      this.ttsService.stop();
    }
  }

  toggleVoice() {
    if (this.voiceService.isProcessing()) return; // Prevent double taps during processing

    if (this.voiceService.isListening()) {
      this.voiceService.stop();
    } else {
      this.ttsService.stop(); 
      this.voiceService.start();
    }
  }

  async handleVoiceCommand(text: string) {
    this.addLog('voice', `User: "${text}"`);
    this.voiceService.transcript.set(''); 

    const command = this.voiceService.parseCommand(text);

    switch (command) {
      case 'ACTIVATE':
        if (!this.isActive()) {
          this.isActive.set(true);
          this.ttsService.speak("System activated. Monitoring environment.");
        } else {
          this.ttsService.speak("System is already active.");
        }
        break;

      case 'DEACTIVATE':
        if (this.isActive()) {
          this.isActive.set(false);
          this.ttsService.speak("Deactivating system. Goodbye.");
        }
        break;

      case 'PAUSE':
        if (this.isActive() && !this.isLoopPaused()) {
          this.stopLoop();
          this.isLoopPaused.set(true);
          this.addLog('system', 'Observation Loop Paused via Voice');
          this.ttsService.speak("Observation paused.");
        }
        break;

      case 'RESUME':
        if (this.isActive() && this.isLoopPaused()) {
          this.isLoopPaused.set(false);
          this.startLoop();
          this.addLog('system', 'Observation Loop Resumed');
          this.ttsService.speak("Resuming observation.");
        }
        break;

      default:
        if (!this.isActive()) {
          this.ttsService.speak("I am currently offline. Say 'Activate' to start.");
          return;
        }
        
        const frame = this.captureFrame();
        if (!frame) return;

        this.isReasoning.set(true);
        const response = await this.geminiService.reasonAndAssist(frame, text, 'question');
        
        this.lastNudge.set(response);
        this.addLog('reasoner', `Answer: "${response}"`);
        this.ttsService.speak(response);
        
        this.isReasoning.set(false);
        break;
    }
  }

  async startCamera() {
    try {
      this.addLog('system', 'Requesting environment access (Camera & Mic)...');
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 640, height: 480 },
        audio: true 
      });

      await this.audioService.initialize(stream);

      if (this.videoElement && this.videoElement.nativeElement) {
        this.videoElement.nativeElement.srcObject = stream;
      }
      this.addLog('system', 'Visual & Audio access granted. Observer active.');
    } catch (err: any) {
      console.error("Camera error", err);
      this.isActive.set(false); 
      
      // Handle specific, common errors to give better user feedback.
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        // This error can mean the user explicitly denied permission, or it can be a security block.
        if (typeof window !== 'undefined' && !window.isSecureContext) {
           this.addLog('system', 'CRITICAL: Insecure Context. Access denied by browser.');
           alert("Camera/Microphone access is blocked.\n\nThis page is not running in a secure context (HTTPS), and browsers require this for media access. Please ensure you are using an HTTPS URL.");
        } else {
           this.addLog('system', 'CRITICAL: Permission Denied by user.');
           alert("Camera/Microphone access was denied.\n\nPlease grant permission in your browser's address bar or settings.");
        }
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
         this.addLog('system', 'CRITICAL: No devices found.');
         alert("Error: No compatible camera or microphone was found on your device.");
      } else {
        // A catch-all for other, less common errors.
        this.addLog('system', `Error accessing devices: ${err.message}`);
        alert(`An unexpected error occurred while trying to access your camera/microphone: ${err.message}`);
      }
    }
  }

  stopCamera() {
    if (this.videoElement && this.videoElement.nativeElement && this.videoElement.nativeElement.srcObject) {
      const stream = this.videoElement.nativeElement.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      this.videoElement.nativeElement.srcObject = null;
    }
  }

  startLoop() {
    this.scheduleNextLoop();
  }

  stopLoop() {
    if (this.loopTimeout) clearTimeout(this.loopTimeout);
  }

  scheduleNextLoop() {
    this.stopLoop(); 

    if (!this.isActive()) return;
    if (this.isLoopPaused()) return; 

    this.loopTimeout = setTimeout(async () => {
      if (this.isActive() && !this.isLoopPaused() && !this.isReasoning() && !this.voiceService.isListening()) {
        await this.runObservationCycle();
      }
      this.scheduleNextLoop();
    }, this.loopIntervalMs());
  }

  captureFrame(): string | null {
    if (!this.canvasElement || !this.videoElement) return null;
    const video = this.videoElement.nativeElement;
    const canvas = this.canvasElement.nativeElement;
    if (video.videoWidth === 0) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(video, 0, 0);
    
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    return dataUrl.split(',')[1]; 
  }

  async runObservationCycle() {
    if (this.isLoopPaused()) return;

    const frame = this.captureFrame();
    if (!frame) return;

    const audioSegment = await this.audioService.getAudioSegment();

    this.isObserving.set(true);
    
    const result = await this.geminiService.observeEnvironment(frame, audioSegment);
    this.currentObservation.set(result);
    this.isObserving.set(false);

    if (result.observation) {
       this.addLog('observer', `Scanning: ${result.observation} (${Math.round(result.confidence * 100)}%)`);
    }

    const currentInterval = this.loopIntervalMs();
    let newInterval = 8000; 

    if (result.confidence > 0.3 && result.confidence <= 0.6) {
      newInterval = 2500; 
    }

    if (currentInterval !== newInterval) {
      this.loopIntervalMs.set(newInterval);
      if (newInterval < currentInterval) {
        this.addLog('system', 'Activity detected. Entering FOCUS mode (2.5s).');
      } else {
        this.addLog('system', 'Activity cleared. Returning to MONITOR mode (8s).');
      }
    }

    if (result.needsAssistance && result.confidence > 0.6) {
      this.triggerReasoning(frame, result.observation);
    }
  }

  async triggerReasoning(frame: string, observation: string) {
    this.isReasoning.set(true);
    this.addLog('reasoner', 'Confusion detected. Accessing Life Log & Deep Thinking...');
    
    const nudge = await this.geminiService.reasonAndAssist(frame, observation, 'observation');
    
    this.lastNudge.set(nudge);
    this.addLog('reasoner', `Output: "${nudge}"`);
    this.ttsService.speak(nudge);
    
    this.isReasoning.set(false);
  }

  addLog(type: 'observer' | 'reasoner' | 'system' | 'voice', message: string) {
    this.logs.update(prev => [{
      time: new Date().toLocaleTimeString(),
      type,
      message
    }, ...prev].slice(0, 10)); 
  }

  getLifeLogPreview() {
    return LIFE_LOG;
  }
}