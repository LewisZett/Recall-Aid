import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AudioService {
  // Signal for UI visualization (0-100)
  audioLevel = signal(0);
  
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array | null = null;
  private animationId: number | null = null;

  // Raw PCM Data Buffer
  private leftChannelData: Float32Array[] = [];
  private totalSamples = 0;
  private readonly TARGET_SAMPLE_RATE = 16000; // Standard for AI

  async initialize(stream: MediaStream) {
    this.cleanup();

    try {
      // Attempt to create context with specific sample rate for AI compatibility
      try {
        this.context = new AudioContext({ sampleRate: this.TARGET_SAMPLE_RATE });
      } catch (e) {
        console.warn('Could not force 16kHz, falling back to default', e);
        this.context = new AudioContext();
      }
      
      if (this.context.state === 'suspended') {
        await this.context.resume();
      }

      this.source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = 0.8;
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      // Buffer size 4096 is a good balance
      this.processor = this.context.createScriptProcessor(4096, 1, 1);

      this.source.connect(this.analyser);
      this.analyser.connect(this.processor);
      this.processor.connect(this.context.destination);

      this.processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        // Important: Float32Array from getChannelData is valid only during this event
        // We must slice/clone it.
        const dataClone = inputData.slice();
        this.leftChannelData.push(dataClone);
        this.totalSamples += dataClone.length;
      };

      this.measureVolume();
      console.log(`Audio monitoring started at ${this.context.sampleRate}Hz`);

    } catch (e) {
      console.error('Failed to initialize AudioService', e);
      // Ensure we don't leave broken state
      this.cleanup();
    }
  }

  private measureVolume() {
    if (!this.analyser || !this.dataArray) return;
    
    this.analyser.getByteFrequencyData(this.dataArray);
    
    let sum = 0;
    for (const value of this.dataArray) {
      sum += value;
    }
    const avg = sum / this.dataArray.length;
    
    const normalized = Math.min(100, Math.round((avg / 255) * 100)); 
    this.audioLevel.set(normalized);

    this.animationId = requestAnimationFrame(() => this.measureVolume());
  }

  async getAudioSegment(): Promise<string | null> {
    if (!this.context || this.leftChannelData.length === 0) return null;

    // 1. Flatten Buffer
    const flattened = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const buf of this.leftChannelData) {
      flattened.set(buf, offset);
      offset += buf.length;
    }

    // 2. Clear Buffer Immediately
    this.leftChannelData = [];
    this.totalSamples = 0;

    if (flattened.length === 0) return null;

    // 3. Encode to WAV
    try {
      const wavBuffer = this.encodeWAV(flattened, this.context.sampleRate);
      return await this.arrayBufferToBase64Async(wavBuffer);
    } catch (e) {
      console.error("WAV Encoding failed", e);
      return null;
    }
  }

  private encodeWAV(samples: Float32Array, sampleRate: number): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // RIFF identifier
    this.writeString(view, 0, 'RIFF');
    // RIFF chunk length
    view.setUint32(4, 36 + samples.length * 2, true);
    // RIFF type
    this.writeString(view, 8, 'WAVE');
    // format chunk identifier
    this.writeString(view, 12, 'fmt ');
    // format chunk length
    view.setUint32(16, 16, true);
    // sample format (raw)
    view.setUint16(20, 1, true);
    // channel count (1)
    view.setUint16(22, 1, true);
    // sample rate
    view.setUint32(24, sampleRate, true);
    // byte rate (sampleRate * blockAlign)
    view.setUint32(28, sampleRate * 2, true);
    // block align (channel count * bytes per sample)
    view.setUint16(32, 2, true);
    // bits per sample
    view.setUint16(34, 16, true);
    // data chunk identifier
    this.writeString(view, 36, 'data');
    // data chunk length
    view.setUint32(40, samples.length * 2, true);

    // Write PCM samples
    this.floatTo16BitPCM(view, 44, samples);

    return buffer;
  }

  private floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      // Clamp between -1 and 1
      let s = Math.max(-1, Math.min(1, input[i]));
      // Scale to 16-bit integer range
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      output.setInt16(offset, s, true);
    }
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  // Robust Async Base64 conversion using Blob/FileReader
  // This avoids stack overflow issues with large strings in window.btoa
  private arrayBufferToBase64Async(buffer: ArrayBuffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const blob = new Blob([buffer], { type: 'audio/wav' });
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        // Strip the data:audio/wav;base64, prefix
        const base64 = dataUrl.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  
  cleanup() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.analyser) {
        this.analyser.disconnect();
        this.analyser = null;
    }
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }

    this.leftChannelData = [];
    this.totalSamples = 0;
    this.audioLevel.set(0);
  }
}