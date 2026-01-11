import { Injectable, signal, inject } from '@angular/core';
import { EncryptionService } from './encryption.service';

export interface MemoryEntry {
  timestamp: number;
  type: 'observation' | 'action' | 'user_voice' | 'system';
  content: string;
}

@Injectable({
  providedIn: 'root'
})
export class MemoryService {
  private encryptionService = inject(EncryptionService);

  // Rolling buffer for AI Context (Last 30 mins)
  private shortTermHistory: MemoryEntry[] = [];
  
  // Full Session History
  private sessionHistory: MemoryEntry[] = [];
  
  // Public signal for UI binding
  public historySignal = signal<MemoryEntry[]>([]);
  
  // Learned Preferences
  private successfulStrategies: string[] = [];
  private failedStrategies: string[] = [];
  
  private readonly STORAGE_KEY = 'recall_aid_secure_mem';

  constructor() {
    this.loadFromSecureStorage();
    // Run purge every hour
    setInterval(() => this.purgeOldData(), 3600000);
  }

  /**
   * Adds an event to memory.
   */
  addEvent(type: 'observation' | 'action' | 'user_voice' | 'system', content: string) {
    const now = Date.now();
    const entry: MemoryEntry = { timestamp: now, type, content };
    
    this.shortTermHistory.push(entry);
    this.pruneShortTerm();
    
    this.sessionHistory.unshift(entry);
    // Hard limit for RAM
    if (this.sessionHistory.length > 200) this.sessionHistory.pop();
    
    this.historySignal.set([...this.sessionHistory]);
    this.saveToSecureStorage();
  }

  getSessionHistory() {
    return this.sessionHistory;
  }

  learnFromFeedback(nudgeContent: string, isHelpful: boolean) {
    if (isHelpful) {
      if (!this.successfulStrategies.includes(nudgeContent)) {
        this.successfulStrategies.push(nudgeContent);
        if (this.successfulStrategies.length > 5) this.successfulStrategies.shift();
      }
    } else {
      if (!this.failedStrategies.includes(nudgeContent)) {
        this.failedStrategies.push(nudgeContent);
        if (this.failedStrategies.length > 5) this.failedStrategies.shift();
      }
    }
    this.saveToSecureStorage();
  }

  getRecentContextString(): string {
    this.pruneShortTerm();
    if (this.shortTermHistory.length === 0) return "No recent history.";

    return this.shortTermHistory.map(h => {
      const time = new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${h.type.toUpperCase()}: ${h.content}`;
    }).join('\n');
  }

  getLearnedPreferencesString(): string {
    let pref = "";
    if (this.successfulStrategies.length > 0) {
      pref += `EFFECTIVE STYLES (Do this): ${JSON.stringify(this.successfulStrategies)}\n`;
    }
    if (this.failedStrategies.length > 0) {
      pref += `INEFFECTIVE STYLES (Avoid this): ${JSON.stringify(this.failedStrategies)}\n`;
    }
    return pref || "No specific preferences learned yet.";
  }
  
  // --- PRIVACY & STORAGE ---

  private pruneShortTerm() {
    const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
    this.shortTermHistory = this.shortTermHistory.filter(h => h.timestamp > thirtyMinutesAgo);
  }

  private purgeOldData() {
    console.log('Privacy: Running 24-hour Data Purge...');
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    const initialCount = this.sessionHistory.length;
    this.sessionHistory = this.sessionHistory.filter(h => h.timestamp > oneDayAgo);
    this.shortTermHistory = this.shortTermHistory.filter(h => h.timestamp > oneDayAgo);
    
    const purgedCount = initialCount - this.sessionHistory.length;
    if (purgedCount > 0) {
        console.log(`Privacy: Purged ${purgedCount} old records.`);
    }
    
    this.historySignal.set([...this.sessionHistory]);
    this.saveToSecureStorage();
  }

  private async saveToSecureStorage() {
    const data = {
      history: this.sessionHistory,
      success: this.successfulStrategies,
      fail: this.failedStrategies
    };
    try {
      const encrypted = await this.encryptionService.encrypt(data);
      localStorage.setItem(this.STORAGE_KEY, encrypted);
    } catch (e) {
      console.warn('Failed to save secure memory', e);
    }
  }

  private async loadFromSecureStorage() {
    const raw = localStorage.getItem(this.STORAGE_KEY);
    if (!raw) return;

    try {
      const data = await this.encryptionService.decrypt(raw);
      if (data) {
        // Apply 24h filter immediately upon load
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        
        if (data.history) {
            this.sessionHistory = data.history.filter((h: MemoryEntry) => h.timestamp > oneDayAgo);
            this.historySignal.set([...this.sessionHistory]);
            
            // Rebuild short term from session history
            const thirtyMinAgo = Date.now() - (30 * 60 * 1000);
            this.shortTermHistory = this.sessionHistory.filter(h => h.timestamp > thirtyMinAgo);
        }
        if (data.success) this.successfulStrategies = data.success;
        if (data.fail) this.failedStrategies = data.fail;
      }
    } catch (e) {
      console.warn('Failed to load secure memory', e);
    }
  }
  
  clearAll() {
    this.shortTermHistory = [];
    this.sessionHistory = [];
    this.historySignal.set([]);
    this.successfulStrategies = [];
    this.failedStrategies = [];
    localStorage.removeItem(this.STORAGE_KEY);
  }
}