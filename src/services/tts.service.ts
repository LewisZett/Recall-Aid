import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class TtsService {
  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  
  // Public state signals for UI
  isSpeaking = signal(false);
  speechRate = signal(0.9); // Default slow/gentle
  speechPitch = signal(1.1); // Default slightly higher

  constructor() {
    if (typeof window !== 'undefined') {
      const win = window as any;
      // Try standard API then webkit prefix
      this.synth = win.speechSynthesis || win.webkitSpeechSynthesis;
      
      if (this.synth) {
        this.initVoice();
        // Handle async voice loading
        if (this.synth.onvoiceschanged !== undefined) {
           this.synth.onvoiceschanged = () => this.initVoice();
        }
      } else {
        console.warn('Text-to-Speech API is not available in this environment.');
      }
    }
  }

  private initVoice() {
    if (!this.synth) return;

    const voices = this.synth.getVoices();
    // Prefer a gentle female voice often used for assistants
    this.voice = voices.find(v => v.name.includes('Google US English')) || 
                 voices.find(v => v.lang === 'en-US') || 
                 voices[0];
  }

  speak(text: string) {
    if (!this.synth) return;

    // Interrupt previous speech for immediate feedback
    this.synth.cancel();
    this.isSpeaking.set(false);

    if (!text) return;

    const utterance = new SpeechSynthesisUtterance(text);
    if (this.voice) {
      utterance.voice = this.voice;
    }
    utterance.rate = this.speechRate(); 
    utterance.pitch = this.speechPitch();
    
    // Track state
    utterance.onstart = () => this.isSpeaking.set(true);
    utterance.onend = () => this.isSpeaking.set(false);
    utterance.onerror = () => this.isSpeaking.set(false);
    
    this.synth.speak(utterance);
  }

  stop() {
    if (this.synth) {
      this.synth.cancel();
      this.isSpeaking.set(false);
    }
  }
}