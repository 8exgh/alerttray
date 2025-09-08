import { sign } from 'jsonwebtoken';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

export class ApnsClient {
  private teamId: string;
  private keyId: string;
  private privateKey: string | null = null;
  private bundleId: string;
  
  constructor() {
    this.teamId = process.env.APNS_TEAM_ID || '';
    this.keyId = process.env.APNS_KEY_ID || '';
    this.bundleId = process.env.APNS_BUNDLE_ID || '';
    
    // Try to load the private key if it exists
    const keyPath = path.join(__dirname, '..', 'certificates', 'AuthKey.p8');
    if (fs.existsSync(keyPath)) {
      try {
        this.privateKey = fs.readFileSync(keyPath, 'utf8');
      } catch (error) {
        console.warn('Failed to read APNS private key:', error);
      }
    }
    
    if (!this.teamId) console.warn("APNS_TEAM_ID not configured");
    if (!this.keyId) console.warn("APNS_KEY_ID not configured");
    if (!this.bundleId) console.warn("APNS_BUNDLE_ID not configured");
    if (!this.privateKey) console.warn("APNS private key not found at certificates/AuthKey.p8");
  }
  
  private isConfigured(): boolean {
    return !!(this.teamId && this.keyId && this.bundleId && this.privateKey);
  }
  
  private generateToken(): string {
    if (!this.privateKey) {
      throw new Error('APNS private key not configured');
    }
    
    return sign(
      { iss: this.teamId },
      this.privateKey,
      {
        algorithm: 'ES256',
        keyid: this.keyId,
        expiresIn: '1h'
      }
    );
  }
  
  async sendNotification(
    deviceToken: string,
    payload: {
      title: string;
      message: string;
      badge?: number;
      sound?: string;
      data?: Record<string, any>;
    }
  ): Promise<void> {
    if (!this.isConfigured()) {
      console.warn('APNS not fully configured, skipping push notification');
      // In development, we'll just log instead of failing
      console.log('Would send push:', { deviceToken, payload });
      return;
    }
    
    const token = this.generateToken();
    const environment = process.env.NODE_ENV === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    
    const apnsPayload = {
      aps: {
        alert: {
          title: payload.title,
          body: payload.message
        },
        badge: payload.badge || 1,
        sound: payload.sound || 'default',
        'content-available': 1
      },
      ...payload.data
    };
    
    const response = await fetch(
      `${environment}/3/device/${deviceToken}`,
      {
        method: 'POST',
        headers: {
          'authorization': `bearer ${token}`,
          'apns-topic': this.bundleId,
          'apns-priority': '10',
          'apns-push-type': 'alert'
        },
        body: JSON.stringify(apnsPayload)
      }
    );
    
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`APNS error: ${response.status} - ${body}`);
    }
  }
}