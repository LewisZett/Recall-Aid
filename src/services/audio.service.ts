import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AudioService {
  // Signal for UI visualization (0-100)
  audioLevel = signal(0);
  
  // Voice Fingerprinting Signals
  detectedPitch = signal<number>(0);
  isVoiceMatch = signal<boolean>(true); // Default to true until trained
  private userAveragePitch: number | null = null;
  private pitchSamples: number[] = [];

  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  
  // DSP Nodes
  private highPassFilter: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  private dataArray: Uint8Array | null = null;
  private animationId: number | null = null;

  // Raw PCM Data Buffer
  private leftChannelData: Float32Array[] = [];
  private totalSamples = 0;
  private readonly TARGET_SAMPLE_RATE = 16000; // Standard for AI
  private readonly MAX_BUFFER_SECONDS = 10;
  
  // Worker
  private worker: Worker | null = null;

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      const workerCode = `
        self.onmessage = function(e) {
          const { buffer, sampleRate, userAveragePitch } = e.data;
          const float32 = new Float32Array(buffer);
          
          // 1. RMS Check
          let sumSquares = 0;
          for (let i = 0; i < float32.length; i++) {
            sumSquares += float32[i] * float32[i];
          }
          const rms = Math.sqrt(sumSquares / float32.length);
          if (rms < 0.05) {
             self.postMessage({ pitch: 0, isMatch: true }); // Silence matches everything effectively
             return;
          }

          // 2. Auto-correlation for Pitch
          const size = float32.length;
          const minPeriod = Math.floor(sampleRate / 300);
          const maxPeriod = Math.floor(sampleRate / 70);

          let bestPeriod = 0;
          let maxCorrelation = 0;

          for (let period = minPeriod; period <= maxPeriod; period++) {
            let correlation = 0;
            for (let i = 0; i < size - period; i++) {
              correlation += float32[i] * float32[i + period];
            }
            if (correlation > maxCorrelation) {
              maxCorrelation = correlation;
              bestPeriod = period;
            }
          }

          let pitch = 0;
          let isMatch = true;

          if (maxCorrelation > 0.5) {
            pitch = Math.round(sampleRate / bestPeriod);
            
            if (userAveragePitch) {
               const variance = Math.abs(pitch - userAveragePitch);
               isMatch = variance < 50;
            }
          }

          self.postMessage({ pitch, isMatch });
        };
      `;
      
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this.worker = new Worker(URL.createObjectURL(blob));
      
      this.worker.onmessage = (e) => {
         const { pitch, isMatch } = e.data;
         if (pitch > 0) {
             this.detectedPitch.set(pitch);
             
             // Main thread handles the learning logic state updates
             if (this.pitchSamples.length < 50) {
                 this.pitchSamples.push(pitch);
                 const total = this.pitchSamples.reduce((a, b) => a + b, 0);
                 this.userAveragePitch = total / this.pitchSamples.length;
             } else {
                 this.isVoiceMatch.set(isMatch);
             }
         }
      };
    }
  }

  async initialize(stream: MediaStream) {
    this.cleanup();

    try {
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

      // --- DSP CHAIN START ---
      this.highPassFilter = this.context.createBiquadFilter();
      this.highPassFilter.type = 'highpass';
      this.highPassFilter.frequency.value = 85;

      this.compressor = this.context.createDynamicsCompressor();
      this.compressor.threshold.value = -24;
      this.compressor.knee.value = 30;
      this.compressor.ratio.value = 12;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.25;

      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048; 
      this.analyser.smoothingTimeConstant = 0.8;
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      this.processor = this.context.createScriptProcessor(4096, 1, 1);

      this.source.connect(this.highPassFilter);
      this.highPassFilter.connect(this.compressor);
      this.compressor.connect(this.analyser);
      this.analyser.connect(this.processor);
      this.processor.connect(this.context.destination);

      // --- DSP CHAIN END ---

      this.processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const dataClone = inputData.slice(); // Copy for buffer
        
        // 1. Buffer Management (Main Thread)
        this.leftChannelData.push(dataClone);
        this.totalSamples += dataClone.length;
        
        const maxSamples = this.TARGET_SAMPLE_RATE * this.MAX_BUFFER_SECONDS;
        while (this.totalSamples > maxSamples + 4096) {
           const removed = this.leftChannelData.shift();
           if (removed) {
             this.totalSamples -= removed.length;
           }
        }
        
        // 2. Offload Analysis to Worker
        if (this.worker) {
            // We transfer the buffer to the worker to avoid copy cost
            // We need another clone if we want to keep it in leftChannelData?
            // Yes, slice() creates a copy. sending the buffer of the copy.
            const bufferToSend = dataClone.buffer; 
            this.worker.postMessage({ 
                buffer: bufferToSend, 
                sampleRate: this.context!.sampleRate,
                userAveragePitch: this.userAveragePitch
            }, [bufferToSend]);
        }
      };

      this.measureVolume();
      console.log(`Audio monitoring started at ${this.context.sampleRate}Hz`);

    } catch (e) {
      console.error('Failed to initialize AudioService', e);
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

    const flattened = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const buf of this.leftChannelData) {
      flattened.set(buf, offset);
      offset += buf.length;
    }

    if (flattened.length === 0) return null;

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
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    this.writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);
    this.floatTo16BitPCM(view, 44, samples);
    return buffer;
  }

  private floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, input[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      output.setInt16(offset, s, true);
    }
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  private arrayBufferToBase64Async(buffer: ArrayBuffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const blob = new Blob([buffer], { type: 'audio/wav' });
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  checkHealth(): boolean {
    if (!this.context) return false;
    return this.context.state === 'running';
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
    if (this.highPassFilter) {
      this.highPassFilter.disconnect();
      this.highPassFilter = null;
    }
    if (this.compressor) {
      this.compressor.disconnect();
      this.compressor = null;
    }
    if (this.analyser) {
        this.analyser.disconnect();
        this.analyser = null;
    }
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }

    if (this.worker) {
        this.worker.terminate();
        this.worker = null;
    }

    this.leftChannelData = [];
    this.totalSamples = 0;
    this.audioLevel.set(0);
    this.detectedPitch.set(0);
  }
}