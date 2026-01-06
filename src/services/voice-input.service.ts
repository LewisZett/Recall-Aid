import { Injectable, signal } from '@angular/core';

// Interface for Web Speech API
interface IWindow extends Window {
  webkitSpeechRecognition: any;
  SpeechRecognition: any;
}

export type SystemCommand = 'ACTIVATE' | 'DEACTIVATE' | 'PAUSE' | 'RESUME' | null;

@Injectable({
  providedIn: 'root'
})
export class VoiceInputService {
  isListening = signal(false);
  isProcessing = signal(false); // Indicates waiting for final result after stop
  transcript = signal<string>('');
  error = signal<string | null>(null);

  private recognition: any;
  private processingTimeout: any;

  constructor() {
    if (typeof window !== 'undefined') {
      const { webkitSpeechRecognition, SpeechRecognition } = window as unknown as IWindow;
      if (!SpeechRecognition && !webkitSpeechRecognition) {
        this.error.set('Speech recognition not supported.');
      }
    }
  }

  private createRecognitionInstance() {
    const { webkitSpeechRecognition, SpeechRecognition } = window as unknown as IWindow;
    const Recognition = SpeechRecognition || webkitSpeechRecognition;

    if (!Recognition) return null;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.lang = 'en-US';
    recognition.interimResults = false; // We only want final results
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      console.log('Voice: Recognition started');
      this.isListening.set(true);
      this.isProcessing.set(false);
      this.error.set(null);
      this.clearProcessingTimeout();
    };

    recognition.onend = () => {
      console.log('Voice: Recognition ended');
      // If we were processing, this is the natural end of that state
      this.resetState();
    };

    recognition.onerror = (event: any) => {
      console.error('Voice: Error', event.error);
      this.resetState();
      
      let msg = '';
      switch (event.error) {
        case 'no-speech':
          // User tapped send but didn't say anything, or silence.
          // Not a critical error, but good to know.
          console.warn('Voice: No speech detected');
          return; 
        case 'audio-capture': msg = 'No microphone found.'; break;
        case 'not-allowed': msg = 'Microphone blocked.'; break;
        case 'network': msg = 'Network error.'; break;
        case 'aborted': return; // Expected when aborting
        default: msg = `Voice Error: ${event.error}`;
      }
      
      if (msg) this.error.set(msg);
    };

    recognition.onresult = (event: any) => {
      console.log('Voice: Result received');
      if (event.results && event.results.length > 0) {
        const result = event.results[0][0];
        if (result && result.transcript) {
          console.log('Voice: Transcript:', result.transcript);
          this.transcript.set(result.transcript);
        }
      }
    };

    return recognition;
  }

  start() {
    this.stopInternal(); // Cleanup any old instances

    this.recognition = this.createRecognitionInstance();
    
    if (this.recognition) {
      try {
        this.transcript.set(''); 
        this.error.set(null); 
        this.isProcessing.set(false);
        this.recognition.start();
      } catch (e) {
        console.error('Mic start error', e);
        this.error.set('Could not start microphone.');
        this.resetState();
      }
    }
  }

  stop() {
    if (this.recognition && this.isListening()) {
      console.log('Voice: Stopping manually...');
      this.isProcessing.set(true); // Show spinner
      
      try {
        this.recognition.stop();
        
        // WATCHDOG: If the browser doesn't fire 'onend' or 'onresult' within 2.5s, 
        // force reset. This prevents the "Endless Processing" loop.
        this.processingTimeout = setTimeout(() => {
          if (this.isProcessing()) {
            console.warn('Voice: Watchdog triggered - forced reset.');
            this.resetState();
          }
        }, 2500);

      } catch (e) {
        console.warn('Error stopping recognition', e);
        this.resetState();
      }
    }
  }

  // Force hard reset of all states and instances
  private stopInternal() {
    this.clearProcessingTimeout();
    if (this.recognition) {
      try { this.recognition.abort(); } catch(e) {}
      this.recognition = null;
    }
    this.isListening.set(false);
    this.isProcessing.set(false);
  }

  private resetState() {
    this.clearProcessingTimeout();
    this.isListening.set(false);
    this.isProcessing.set(false);
  }

  private clearProcessingTimeout() {
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
      this.processingTimeout = null;
    }
  }

  parseCommand(text: string): SystemCommand {
    const cmd = text.toLowerCase().trim();
    if (cmd.includes('activate') || cmd.includes('start system') || cmd.includes('wake up')) return 'ACTIVATE';
    if (cmd.includes('deactivate') || cmd.includes('stop system') || cmd.includes('shut down') || cmd.includes('sleep')) return 'DEACTIVATE';
    if (cmd.includes('pause observation') || cmd.includes('stop watching') || cmd.includes('hold on') || cmd.includes('pause')) return 'PAUSE';
    if (cmd.includes('resume') || cmd.includes('start watching')) return 'RESUME';
    return null;
  }
}