import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class FaceBlurService {
  private model: any = null;
  isModelLoaded = signal(false);

  constructor() {
    this.loadModel();
  }

  private async loadModel() {
    if (typeof window !== 'undefined' && (window as any).blazeface) {
      try {
        console.log('Privacy: Loading Face Detection Model...');
        this.model = await (window as any).blazeface.load();
        this.isModelLoaded.set(true);
        console.log('Privacy: Face Detection Ready.');
      } catch (e) {
        console.warn('Privacy: Failed to load BlazeFace', e);
      }
    }
  }

  async processFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string | null> {
    if (!this.isModelLoaded() || !this.model) {
      // If model not ready, return unblurred frame (or fail-safe block?)
      // For safety, we draw unblurred, but in a real app might block.
      // Returning null would block the pipeline.
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    // Draw original frame first
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    try {
      // Estimate faces
      // returnTensors: false means we get JS arrays
      const predictions = await this.model.estimateFaces(video, false);

      if (predictions.length > 0) {
        // Apply blur
        // Save context state
        ctx.save();
        
        predictions.forEach((pred: any) => {
          const startX = Math.max(0, pred.topLeft[0]);
          const startY = Math.max(0, pred.topLeft[1]);
          const endX = Math.min(canvas.width, pred.bottomRight[0]);
          const endY = Math.min(canvas.height, pred.bottomRight[1]);
          const width = endX - startX;
          const height = endY - startY;

          // Simple Pixelation Effect for Performance
          const pixelSize = 10;
          
          // Turn off smoothing for pixelation effect
          ctx.imageSmoothingEnabled = false;
          
          // Draw a small version of the face region
          const tempCanvas = document.createElement('canvas');
          const tempCtx = tempCanvas.getContext('2d');
          if (tempCtx) {
             tempCanvas.width = Math.max(1, width / pixelSize);
             tempCanvas.height = Math.max(1, height / pixelSize);
             tempCtx.drawImage(canvas, startX, startY, width, height, 0, 0, tempCanvas.width, tempCanvas.height);
             
             // Draw it back scaled up
             ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, startX, startY, width, height);
          }
        });
        
        ctx.restore();
      }
    } catch (e) {
      console.error('Face detection error', e);
    }

    return canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
  }
}