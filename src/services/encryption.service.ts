import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class EncryptionService {
  private key: CryptoKey | null = null;
  private readonly ALGORITHM = 'AES-GCM';
  private readonly KEY_USAGE: KeyUsage[] = ['encrypt', 'decrypt'];

  constructor() {
    this.initKey();
  }

  private async initKey() {
    // Try to retrieve existing key from storage (simulating a secure enclave key)
    const rawKey = localStorage.getItem('recall_aid_sek');
    
    if (rawKey) {
      const buffer = Uint8Array.from(atob(rawKey), c => c.charCodeAt(0));
      this.key = await window.crypto.subtle.importKey(
        'raw', 
        buffer, 
        this.ALGORITHM, 
        true, 
        this.KEY_USAGE
      );
    } else {
      // Generate new key
      this.key = await window.crypto.subtle.generateKey(
        { name: this.ALGORITHM, length: 256 },
        true,
        this.KEY_USAGE
      ) as CryptoKey;
      
      const exported = await window.crypto.subtle.exportKey('raw', this.key);
      const str = String.fromCharCode(...new Uint8Array(exported));
      localStorage.setItem('recall_aid_sek', btoa(str));
    }
  }

  async encrypt(data: any): Promise<string> {
    if (!this.key) await this.initKey();
    if (!this.key) throw new Error("Encryption key init failed");

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encodedData = new TextEncoder().encode(JSON.stringify(data));

    const encryptedContent = await window.crypto.subtle.encrypt(
      { name: this.ALGORITHM, iv },
      this.key,
      encodedData
    );

    // Bundle IV and Ciphertext
    const bundle = {
      iv: Array.from(iv),
      content: Array.from(new Uint8Array(encryptedContent))
    };

    return JSON.stringify(bundle);
  }

  async decrypt(bundleStr: string): Promise<any> {
    if (!this.key) await this.initKey();
    if (!this.key) throw new Error("Encryption key init failed");

    try {
      const bundle = JSON.parse(bundleStr);
      const iv = new Uint8Array(bundle.iv);
      const content = new Uint8Array(bundle.content);

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: this.ALGORITHM, iv },
        this.key,
        content
      );

      const decoded = new TextDecoder().decode(decryptedBuffer);
      return JSON.parse(decoded);
    } catch (e) {
      console.error('Decryption failed', e);
      return null;
    }
  }
}