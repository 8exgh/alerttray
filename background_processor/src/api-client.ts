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
  }
  
  private createSignature(body: string): string {
    return createHmac('sha256', this.apiKey)
      .update(body)
      .digest('hex');
  }
  
  async getPendingTasks(): Promise<PushTask[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/tasks`, {
        headers: {
          'X-API-Key': this.apiKey,
          'X-Signature': this.createSignature('')
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to get tasks: ${response.statusText}`);
      }
      
      const data = await response.json() as { tasks: PushTask[] };
      return data.tasks || [];
    } catch (error) {
      console.error('Error getting pending tasks:', error);
      return [];
    }
  }
  
  async reportPushResult(result: PushResult): Promise<void> {
    const body = JSON.stringify(result);
    
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/push-result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'X-Signature': this.createSignature(body)
        },
        body
      });
      
      if (!response.ok) {
        throw new Error(`Failed to report result: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error reporting push result:', error);
      throw error;
    }
  }
}