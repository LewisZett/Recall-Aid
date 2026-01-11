
import { Injectable, inject, signal } from '@angular/core';
import { GoogleGenAI, Type } from '@google/genai';
import { LIFE_LOG } from './lifelog.data';
import { MemoryService } from './memory.service';
import { firstValueFrom, fromEvent, merge, of } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ObservationResult {
  needsAssistance: boolean;
  emergencyLevel: 'NONE' | 'SOFT' | 'CRITICAL';
  cues: ('visual' | 'audio')[];
  confidence: number;
  observation: string;
  contextTrigger?: string;
  isPrivacyZone: boolean;
  detectedLocation: string;
}

interface VectorEntry {
  text: string;
  embedding: number[];
}

interface QueuedTask {
  id: string;
  execute: () => Promise<any>;
  retryable: boolean;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class GeminiService {
  private ai: GoogleGenAI;
  private modelId = 'gemini-2.5-flash';
  private embeddingModelId = 'text-embedding-004';
  
  private memoryService = inject(MemoryService);

  // Cache for Semantic Knowledge Base
  private lifeLogVectors: VectorEntry[] = [];
  private isKnowledgeBaseReady = false;

  // Caching for Observations
  private lastObservation: { result: ObservationResult, timestamp: number, visualHash: number } | null = null;
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache if scene is static

  // Connection Pooling & Queue
  private taskQueue: QueuedTask[] = [];
  private isOnline = true;
  private activeRequests = 0;
  private readonly MAX_CONCURRENT_REQUESTS = 2;
  
  // Rate Limiting
  private backoffUntil = 0;

  // Predictive Context
  predictiveContext = signal<string | null>(null);

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env['API_KEY'] || 'AIzaSyAHNjODuPtk8L6fxQgq8nGtMXlIBkTeaLU' });
    this.initializeKnowledgeBase();
    this.setupNetworkListeners();
    this.initPredictiveLoop();
  }

  private setupNetworkListeners() {
    if (typeof window !== 'undefined') {
      this.isOnline = navigator.onLine;
      window.addEventListener('online', () => {
        this.isOnline = true;
        console.log('Gemini: Online. Processing queue...');
        this.processQueue();
      });
      window.addEventListener('offline', () => {
        this.isOnline = false;
        console.log('Gemini: Offline mode activated.');
      });
    }
  }

  // --- PREDICTIVE PRE-FETCHING ---
  private initPredictiveLoop() {
    if (typeof window !== 'undefined') {
        // Run immediately then every 5 mins
        this.updatePredictiveContext();
        setInterval(() => this.updatePredictiveContext(), 300000);
    }
  }

  private updatePredictiveContext() {
     const now = new Date();
     const currentMinutes = now.getHours() * 60 + now.getMinutes();
     
     // Look ahead 30 mins
     const upcomingEvents = LIFE_LOG.daily_routine.filter(event => {
        const [h, m] = event.time.split(':').map(Number);
        const eventMinutes = h * 60 + m;
        const diff = eventMinutes - currentMinutes;
        return diff >= 0 && diff <= 30;
     });

     if (upcomingEvents.length > 0) {
        const context = `UPCOMING ROUTINE: ${upcomingEvents.map(e => `${e.time}: ${e.task}`).join(', ')}`;
        this.predictiveContext.set(context);
        console.log('Gemini: Predictive context updated:', context);
     } else {
        this.predictiveContext.set(null);
     }
  }

  // --- HEALTH CHECK ---
  async checkConnectivity(): Promise<boolean> {
    if (!this.isOnline) return false;
    if (Date.now() < this.backoffUntil) return false; // Consider offline if rate limited

    try {
      // Use generateContent instead of embedContent for basic health check
      // as it uses the main model which is guaranteed to be available.
      await this.ai.models.generateContent({
        model: this.modelId,
        contents: "ping",
        config: { maxOutputTokens: 1 }
      });
      return true;
    } catch (e) {
      console.warn('Gemini Health Check Failed', e);
      return false;
    }
  }
  
  // --- REPORT GENERATION ---
  async generateActivityReport(logs: string[]): Promise<string> {
      if (!this.isOnline) return "Report unavailable (Offline).";
      if (Date.now() < this.backoffUntil) return "Report unavailable (API Cooldown).";
      
      const logText = logs.join('\n');
      const prompt = `
        You are an admin assistant for a memory care application.
        Summarize the following activity logs for a caregiver. 
        Focus on:
        1. Medication compliance (Did they take meds?).
        2. Any confusion or anxiety episodes.
        3. General activity level.
        4. Any safety warnings.
        
        Keep it professional, reassuring, and concise (max 100 words).
        
        LOGS:
        ${logText}
      `;
      
      return this.enqueue(async () => {
          try {
            const response = await this.ai.models.generateContent({
                model: this.modelId,
                contents: { parts: [{ text: prompt }] }
            });
            return response.text || "No summary generated.";
          } catch (e: any) {
            this.handleError(e);
            throw e;
          }
      }, true);
  }

  // --- QUEUE MANAGEMENT (POOLING) ---

  private enqueue<T>(taskFn: () => Promise<T>, retryable: boolean): Promise<T> {
    return new Promise((resolve, reject) => {
      // Create task object
      const task: QueuedTask = {
        id: Math.random().toString(36),
        execute: taskFn,
        retryable,
        resolve,
        reject,
        timestamp: Date.now()
      };

      if (!this.isOnline) {
          if (retryable) {
              console.log('Gemini: Offline. Task queued.');
              this.addToQueue(task);
          } else {
              reject(new Error('Offline: Task dropped'));
          }
          return;
      }
      
      this.addToQueue(task);
      this.processQueue();
    });
  }

  private addToQueue(task: QueuedTask) {
    this.taskQueue.push(task);
  }

  private processQueue() {
    if (!this.isOnline) return;
    
    // Check for global backoff
    if (Date.now() < this.backoffUntil) {
        setTimeout(() => this.processQueue(), 1000);
        return;
    }

    // Filter stale tasks
    const now = Date.now();
    this.taskQueue = this.taskQueue.filter(t => now - t.timestamp < 300000);

    // Process up to MAX_CONCURRENT_REQUESTS
    while (this.activeRequests < this.MAX_CONCURRENT_REQUESTS && this.taskQueue.length > 0) {
       const task = this.taskQueue.shift();
       if (task) {
          this.activeRequests++;
          
          task.execute()
            .then(result => task.resolve(result))
            .catch(error => {
                // If the error was a rate limit, it should have already set backoffUntil via handleError
                // If it's retryable and we hit a transient error, we could re-enqueue
                // But for now, we just reject to avoid infinite loops
                task.reject(error);
            })
            .finally(() => {
                this.activeRequests--;
                // Check if more tasks can be processed
                this.processQueue();
            });
       }
    }
  }

  private handleError(e: any) {
      const errStr = JSON.stringify(e);
      if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')) {
           console.warn('Gemini: Rate Limit Exceeded (429). Backing off for 30s.');
           this.backoffUntil = Date.now() + 30000;
      }
  }

  // --- INITIALIZATION ---

  private async initializeKnowledgeBase() {
    try {
      const chunks: string[] = [];
      // Flatten Profile
      chunks.push(`User Profile: ${LIFE_LOG.user_profile.name}, ${LIFE_LOG.user_profile.condition}. ${LIFE_LOG.user_profile.notes}`);
      // Flatten Meds
      LIFE_LOG.medication_reminders.forEach(med => {
        chunks.push(`Medication Reminder: At ${med.time}, take ${med.dosage} of ${med.medication}. Location: ${med.location}. Instructions: ${med.instructions}.`);
      });
      // Flatten Routine
      LIFE_LOG.daily_routine.forEach(task => {
        chunks.push(`Daily Routine: At ${task.time}, ${task.task}.`);
      });
      // Flatten Map
      Object.entries(LIFE_LOG.home_map).forEach(([room, data]: [string, any]) => {
        chunks.push(`Home Map - ${room}: ${data.description} Contains: ${data.critical_items.join(', ')}. Privacy Sensitive: ${data.privacy_sensitive}.`);
      });
      // Flatten People
      LIFE_LOG.social_circle.forEach(person => {
        chunks.push(`Social Connection: ${person.name} is the ${person.relationship}. Description: ${person.description}.`);
      });

      if (chunks.length === 0) return;

      const promises = chunks.map(async (chunk) => {
        try {
          const response = await this.ai.models.embedContent({
            model: this.embeddingModelId,
            content: { parts: [{ text: chunk }] }
          });
          return { chunk, embedding: response.embedding?.values };
        } catch (error) {
          return { chunk, embedding: null };
        }
      });

      const results = await Promise.all(promises);
      results.forEach(result => {
         if (result.embedding) {
           this.lifeLogVectors.push({
             text: result.chunk,
             embedding: result.embedding
           });
         }
      });
      
      if (this.lifeLogVectors.length > 0) {
        this.isKnowledgeBaseReady = true;
      }

    } catch (e) {
      console.error('Gemini: Failed to init knowledge base', e);
    }
  }

  private async searchKnowledgeBase(query: string, limit = 3): Promise<string[]> {
    if (!this.isKnowledgeBaseReady) return [JSON.stringify(LIFE_LOG)]; 

    try {
      const queryEmbedding = await this.ai.models.embedContent({
        model: this.embeddingModelId,
        content: { parts: [{ text: query }] }
      });
      
      if (!queryEmbedding.embedding || !queryEmbedding.embedding.values) return [];

      const queryVec = queryEmbedding.embedding.values;

      const scored = this.lifeLogVectors.map(entry => {
        return {
          text: entry.text,
          score: this.cosineSimilarity(queryVec, entry.embedding)
        };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map(s => s.text);
    } catch (e) {
      console.error('Gemini: Search failed', e);
      return [];
    }
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // The "Observer": Fast, low latency check
  async observeEnvironment(base64Image: string, base64Audio: string | null = null, visualChangeScore: number = 100): Promise<ObservationResult> {
    
    // OFFLINE CHECK OR RATE LIMIT
    if (!this.isOnline || Date.now() < this.backoffUntil) {
       return this.runOfflineFallbackAnalysis(visualChangeScore);
    }

    // CACHING CHECK
    if (!base64Audio && visualChangeScore < 5 && this.lastObservation) {
      const age = Date.now() - this.lastObservation.timestamp;
      if (age < this.CACHE_TTL_MS) {
        return this.lastObservation.result;
      }
    }

    return this.enqueue(async () => {
        const now = new Date();
        const timeString = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const medSchedule = JSON.stringify(LIFE_LOG.medication_reminders);
        const mapContext = JSON.stringify(LIFE_LOG.home_map);
        const prediction = this.predictiveContext() ? `\nPREDICTIVE CONTEXT: ${this.predictiveContext()}` : '';

        const prompt = `
          You are the 'Observer' for Recall Aid. 
          CURRENT TIME: ${timeString}
          MEDICATION SCHEDULE: ${medSchedule}
          HOME MAP: ${mapContext}
          ${prediction}

          Analyze the video frame ${base64Audio ? 'AND the ambient audio snippet' : ''}.
          
          TASK 1: Detect Status
          - Look/Listen for hesitation, confusion, searching, or hazards.
          - Check Medication Compliance if time matches schedule.

          TASK 2: Classify EMERGENCY_LEVEL
          - 'NONE': Normal behavior.
          - 'SOFT': Confusion, searching for long time, minor distress, negative emotion (crying).
          - 'CRITICAL': Fall detected, unconsciousness, screaming for help, bleeding, fire, heavy crashing sounds.

          TASK 3: Identify CUES (Select all that apply)
          - 'visual': Derived from image (body on floor, blood, fire).
          - 'audio': Derived from sound (screaming, crashing, glass breaking, "Help me").

          TASK 4: Identify LOCATION & PRIVACY
          - Based on the HOME MAP and visual features, identify the 'detectedLocation'.
          - Check if this location is 'privacy_sensitive' (e.g., Bathroom, Toilet, Bedroom changing area).
          - Set 'isPrivacyZone' to TRUE if it is a sensitive area.

          Constraint: Be conservative. Only flag 'needsAssistance' if you are > 60% confident.
          
          Return JSON.
        `;

        const parts: any[] = [
          { text: prompt },
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: base64Image
            }
          }
        ];

        if (base64Audio && base64Audio.length > 100) {
          parts.push({
            inlineData: {
              mimeType: 'audio/wav',
              data: base64Audio
            }
          });
        }

        try {
          const response = await this.ai.models.generateContent({
            model: this.modelId,
            contents: {
              role: 'user',
              parts: parts
            },
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  needsAssistance: { type: Type.BOOLEAN },
                  emergencyLevel: { type: Type.STRING, enum: ['NONE', 'SOFT', 'CRITICAL'] },
                  cues: { 
                    type: Type.ARRAY, 
                    items: { type: Type.STRING, enum: ['visual', 'audio'] },
                  },
                  confidence: { type: Type.NUMBER, description: "0.0 to 1.0" },
                  observation: { type: Type.STRING },
                  contextTrigger: { type: Type.STRING },
                  detectedLocation: { type: Type.STRING },
                  isPrivacyZone: { type: Type.BOOLEAN }
                },
                required: ["needsAssistance", "emergencyLevel", "cues", "confidence", "observation", "detectedLocation", "isPrivacyZone"]
              }
            }
          });

          const text = response.text;
          if (!text) throw new Error("No response from Observer");
          
          const result = JSON.parse(text) as ObservationResult;
          
          if (result.observation) {
            this.memoryService.addEvent('observation', result.observation);
          }
          
          // Update Cache
          this.lastObservation = {
            result,
            timestamp: Date.now(),
            visualHash: visualChangeScore // Using score as proxy for hash state
          };

          return result;
        } catch (e: any) {
          console.error("Observer Error Details:", e);
          this.handleError(e); // Check for 429
          
          if (base64Audio && e.message && (e.message.includes('400') || e.message.includes('INVALID_ARGUMENT'))) {
             // Retry without audio
             return this.observeEnvironment(base64Image, null, visualChangeScore);
          }
          // If offline error caught here, try fallback
          return this.runOfflineFallbackAnalysis(visualChangeScore);
        }
    }, false); // Observations are NOT retryable via queue, we handle offline above
  }

  // The "Reasoner": Deep thinking with Memory, Semantic Search, and Learning
  async reasonAndAssist(base64Image: string, input: string, mode: 'observation' | 'question' = 'observation'): Promise<string> {
    
    // Check Rate Limit
    if (Date.now() < this.backoffUntil) {
        return "I need a moment to rest my circuits (Rate Limit).";
    }

    // Reason requests are RETRYABLE (e.g., if net fails, we want to answer the question eventually)
    return this.enqueue(async () => {
        const now = new Date();
        const timeString = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        
        try {
            const relevantKnowledge = await this.searchKnowledgeBase(input + " " + timeString);
            const recentHistory = this.memoryService.getRecentContextString();
            const learnedPrefs = this.memoryService.getLearnedPreferencesString();

            const prompt = `
              You are the 'Reasoner' for Recall Aid.
              
              --- CONTEXTUAL KNOWLEDGE (Semantic Match) ---
              ${relevantKnowledge.join('\n')}

              --- SHORT-TERM MEMORY (Last 30 mins) ---
              ${recentHistory}

              --- LEARNED USER PREFERENCES ---
              ${learnedPrefs}

              --- CURRENT STATUS ---
              TIME: ${timeString}
              INPUT: "${input}"
              MODE: ${mode.toUpperCase()}
              ${this.predictiveContext() ? `PREDICTED CONTEXT: ${this.predictiveContext()}` : ''}

              TASK: Determine the best assistance. 
              - Keep it short (max 2 sentences).
              - Be supportive but direct.
              - Use the preferences to adjust your tone.
            `;

            const response = await this.ai.models.generateContent({
              model: this.modelId,
              contents: {
                role: 'user',
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType: 'image/jpeg',
                      data: base64Image
                    }
                  }
                ]
              },
              config: {
                thinkingConfig: {
                  thinkingBudget: 1024, 
                },
              }
            });

            const nudge = response.text || "I'm here if you need help.";
            this.memoryService.addEvent('action', nudge);
            return nudge;
        } catch(e: any) {
             this.handleError(e);
             throw e;
        }
    }, true); // Retryable
  }

  // --- OFFLINE FALLBACK LOGIC ---
  private runOfflineFallbackAnalysis(visualChangeScore: number): ObservationResult {
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();

      // 1. Check Schedule (Rule-based Fallback)
      // Check medication +/- 15 mins
      const activeMed = LIFE_LOG.medication_reminders.find(m => {
          const [h, min] = m.time.split(':').map(Number);
          const t = h * 60 + min;
          return Math.abs(t - currentMinutes) <= 15;
      });

      let observation = "System Offline. Monitoring sensors locally.";
      let needsAssistance = false;
      let confidence = 0.1;
      let emergencyLevel: 'NONE' | 'SOFT' = 'NONE';

      if (activeMed) {
          observation = `Offline Reminder: Scheduled time for ${activeMed.medication} (${activeMed.time}).`;
          needsAssistance = true;
          confidence = 0.6; // Higher confidence because it's a schedule match
      }

      // 2. High Motion Fallback
      if (visualChangeScore > 80) {
           observation += " Significant motion detected.";
           // If we have motion but no AI, we might just flag it
           confidence = Math.max(confidence, 0.4);
      }

      return {
          needsAssistance,
          emergencyLevel: 'NONE', // Never trigger critical in offline blind mode
          cues: [],
          confidence,
          observation,
          isPrivacyZone: false,
          detectedLocation: 'Unknown (Offline)'
      };
  }

  private getEmptyObservation(msg: string): ObservationResult {
      return { 
        needsAssistance: false, 
        emergencyLevel: 'NONE',
        cues: [],
        confidence: 0, 
        observation: msg,
        isPrivacyZone: false,
        detectedLocation: 'Unknown'
      };
  }
}
