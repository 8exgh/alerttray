import { createHmac } from 'crypto';
import fetch from 'node-fetch';

export type Channel = 'apns' | 'call' | 'sms' | 'email' | 'emergency';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** One delivery of one notification to one recipient over one channel. */
export interface DeliveryTask {
  id: string;
  notificationId: string;
  userId: string;
  channel: Channel;
  /** Device token (apns), E.164 phone number (call/sms) or email address (email). */
  recipient: string;
  title: string;
  message: string;
  severity: Severity;
  data?: Record<string, any>;
  attempts: number;
}

export interface DeliveryResult {
  taskId: string;
  notificationId: string;
  success: boolean;
  errorMessage?: string;
  /** Provider-side id: APNS id, gateway call/sms sid, email message id. */
  providerMessageId?: string;
}

function assert(condition: any, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  
  constructor() {
    this.baseUrl = process.env.ALERTTRAY_API_URL || 'http://localhost:3000';
    this.apiKey = process.env.API_KEY || '';
    
    assert(this.apiKey, "API_KEY environment variable is required");
    
    // Log initialization (mask API key for security)
    console.log(`🔧 ApiClient initialized:`);
    console.log(`  - Base URL: ${this.baseUrl}`);
    console.log(`  - API Key: ${this.apiKey.substring(0, 3)}...${this.apiKey.length > 3 ? ` (${this.apiKey.length} chars)` : ''}`);
  }
  
  private createSignature(body: string): string {
    return createHmac('sha256', this.apiKey)
      .update(body)
      .digest('hex');
  }
  
  async getPendingTasks(): Promise<DeliveryTask[]> {
    const url = `${this.baseUrl}/api/internal/tasks`;
    const signature = this.createSignature('');
    
    try {
      const response = await fetch(url, {
        headers: {
          'X-API-Key': this.apiKey,
          'X-Signature': signature
        }
      });
      
      if (!response.ok) {
        const responseBody = await response.text();
        console.log(`📡 GET ${url} → ${response.status} ${response.statusText}: ${responseBody}`);
        throw new Error(`Failed to get tasks: ${response.statusText}`);
      }
      
      const data = await response.json() as { tasks: DeliveryTask[] };
      if (data.tasks?.length) {
        console.log(`📡 GET ${url} → ${data.tasks.length} task(s)`);
      }
      return data.tasks || [];
    } catch (error) {
      console.error('❌ Error getting pending tasks:', error);
      return [];
    }
  }
  
  async reportResult(result: DeliveryResult): Promise<void> {
    const body = JSON.stringify(result);
    const url = `${this.baseUrl}/api/internal/push-result`;
    const signature = this.createSignature(body);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'X-Signature': signature
        },
        body
      });
      
      if (!response.ok) {
        const responseBody = await response.text();
        console.log(`📡 POST ${url} → ${response.status} ${response.statusText}: ${responseBody}`);
        throw new Error(`Failed to report result: ${response.statusText}`);
      }
    } catch (error) {
      console.error('❌ Error reporting delivery result:', error);
      throw error;
    }
  }
}
