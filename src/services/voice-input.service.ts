import { Injectable, signal } from '@angular/core';

// Interface for Web Speech API
interface IWindow extends Window {
  webkitSpeechRecognition: any;
  SpeechRecognition: any;
}

export type SystemCommand = 'ACTIVATE' | 'DEACTIVATE' | 'PAUSE' | 'RESUME' | 'EMERGENCY' | 'QUERY' | null;

@Injectable({
  providedIn: 'root'
})
export class VoiceInputService {
  isListening = signal(false);
  isProcessing = signal(false); 
  transcript = signal<string>('');
  error = signal<string | null>(null);

  // New State for Wake Word
  isWakeWordDetected = signal(false);
  readonly WAKE_WORDS = ['hey assist', 'assist', 'hey assistant', 'okay assist'];

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
    recognition.continuous = true; // Use continuous to listen for wake word
    recognition.lang = 'en-US';
    recognition.interimResults = false;
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
      // Auto-restart if we were just listening for wake words and it timed out
      if (this.isListening()) {
        try {
           this.recognition.start();
        } catch(e) {
           this.resetState();
        }
      } else {
        this.resetState();
      }
    };

    recognition.onerror = (event: any) => {
      if (event.error === 'aborted') {
        this.resetState();
        return;
      }
      console.error('Voice: Error', event.error);
      this.resetState();
      let msg = '';
      switch (event.error) {
        case 'no-speech': return; 
        case 'audio-capture': msg = 'No microphone found.'; break;
        case 'not-allowed': msg = 'Microphone blocked.'; break;
        case 'network': msg = 'Network error.'; break;
        default: msg = `Voice Error: ${event.error}`;
      }
      if (msg) this.error.set(msg);
    };

    recognition.onresult = (event: any) => {
      if (event.results && event.results.length > 0) {
        // Get the latest result
        const latestResult = event.results[event.results.length - 1];
        if (latestResult.isFinal) {
           const text = latestResult[0].transcript.toLowerCase().trim();
           console.log('Voice Raw:', text);
           
           if (this.checkForWakeWord(text)) {
              // Strip wake word and set final transcript
              const cleanedText = this.stripWakeWord(text);
              if (cleanedText) {
                this.transcript.set(cleanedText);
                // Stop to process
                this.stop(); 
              } else {
                 // Detected wake word but no command yet?
                 this.isWakeWordDetected.set(true);
              }
           } else if (this.isWakeWordDetected()) {
             // If wake word was recently triggered, accept this
             this.transcript.set(text);
             this.stop();
           }
        }
      }
    };

    return recognition;
  }

  start() {
    this.stopInternal(); 
    this.recognition = this.createRecognitionInstance();
    
    if (this.recognition) {
      try {
        this.transcript.set(''); 
        this.error.set(null); 
        this.isProcessing.set(false);
        this.isWakeWordDetected.set(false);
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
      this.isProcessing.set(true);
      try {
        this.recognition.stop();
        this.processingTimeout = setTimeout(() => {
          if (this.isProcessing()) {
            this.resetState();
          }
        }, 2500);
      } catch (e) {
        this.resetState();
      }
    }
  }

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

  private checkForWakeWord(text: string): boolean {
    return this.WAKE_WORDS.some(w => text.includes(w));
  }

  private stripWakeWord(text: string): string {
    let result = text;
    this.WAKE_WORDS.forEach(w => {
       result = result.replace(w, '');
    });
    return result.trim();
  }

  /**
   * Parses text for commands and handles chaining (AND, THEN).
   */
  parseCommands(text: string): { command: SystemCommand, text: string }[] {
    const rawSegments = text.split(/\s+(?:and|then|also)\s+/i);
    
    return rawSegments.map(segment => {
      const cleanSeg = segment.trim();
      return {
        command: this.identifyCommandType(cleanSeg),
        text: cleanSeg
      };
    });
  }

  private identifyCommandType(text: string): SystemCommand {
    const cmd = text.toLowerCase();
    if (cmd.includes('help') || cmd.includes('emergency') || cmd.includes('911') || cmd.includes('i need help')) return 'EMERGENCY';
    if (cmd.includes('activate') || cmd.includes('start system') || cmd.includes('wake up')) return 'ACTIVATE';
    if (cmd.includes('deactivate') || cmd.includes('stop system') || cmd.includes('shut down')) return 'DEACTIVATE';
    if (cmd.includes('pause')) return 'PAUSE';
    if (cmd.includes('resume')) return 'RESUME';
    
    // If no system keyword, it's a general query/observation request
    return 'QUERY'; 
  }
}