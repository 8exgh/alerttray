import { createHmac } from 'crypto';
import fetch from 'node-fetch';

interface PushTask {
  id: string;
  notificationId: string;
  userId: string;
  deviceToken: string;
  title: string;
  message: string;
  data?: Record<string, any>;
}

interface PushResult {
  taskId: string;
  notificationId: string;
  success: boolean;
  errorMessage?: string;
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
  
  async getPendingTasks(): Promise<PushTask[]> {
    const url = `${this.baseUrl}/api/internal/tasks`;
    const signature = this.createSignature('');
    
    console.log(`📡 GET ${url}`);
    console.log(`  - X-API-Key: ${this.apiKey.substring(0, 3)}...`);
    console.log(`  - X-Signature: ${signature.substring(0, 8)}...`);
    
    try {
      const response = await fetch(url, {
        headers: {
          'X-API-Key': this.apiKey,
          'X-Signature': signature
        }
      });
      
      console.log(`  - Response Status: ${response.status} ${response.statusText}`);
      console.log(`  - Response Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
      
      if (!response.ok) {
        const responseBody = await response.text();
        console.log(`  - Response Body: ${responseBody}`);
        throw new Error(`Failed to get tasks: ${response.statusText}`);
      }
      
      const data = await response.json() as { tasks: PushTask[] };
      console.log(`  ✅ Received ${data.tasks?.length || 0} tasks`);
      return data.tasks || [];
    } catch (error) {
      console.error('❌ Error getting pending tasks:', error);
      return [];
    }
  }
  
  async reportPushResult(result: PushResult): Promise<void> {
    const body = JSON.stringify(result);
    const url = `${this.baseUrl}/api/internal/push-result`;
    const signature = this.createSignature(body);
    
    console.log(`📡 POST ${url}`);
    console.log(`  - X-API-Key: ${this.apiKey.substring(0, 3)}...`);
    console.log(`  - X-Signature: ${signature.substring(0, 8)}...`);
    console.log(`  - Body: ${body.substring(0, 100)}${body.length > 100 ? '...' : ''}`);
    
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
      
      console.log(`  - Response Status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        const responseBody = await response.text();
        console.log(`  - Response Body: ${responseBody}`);
        throw new Error(`Failed to report result: ${response.statusText}`);
      }
      
      console.log(`  ✅ Push result reported successfully`);
    } catch (error) {
      console.error('❌ Error reporting push result:', error);
      throw error;
    }
  }
}