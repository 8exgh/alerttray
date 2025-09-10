import * as dotenv from 'dotenv';
import { ApiClient } from './api-client';
import { PushSender } from './push-sender';

dotenv.config();

function assert(condition: any, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

class BackgroundProcessor {
  private checkInterval = 5000; // Check every 5 seconds
  private apiClient: ApiClient;
  private pushSender: PushSender;
  
  constructor() {
    this.apiClient = new ApiClient();
    this.pushSender = new PushSender();
  }
  
  async start(): Promise<void> {
    console.log('🚀 Background processor started');
    console.log(`  - API URL: ${process.env.ALERTTRAY_API_URL || 'http://localhost:3000'}`);
    console.log(`  - Check interval: ${this.checkInterval}ms`);
    console.log(`  - Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`  - API_KEY present: ${process.env.API_KEY ? 'Yes' : 'No'}`);
    console.log(`  - BACKGROUND_PROCESSOR_API_KEY present: ${process.env.BACKGROUND_PROCESSOR_API_KEY ? 'Yes' : 'No'}`);
    
    let iterationCount = 0;
    
    while (true) {
      try {
        iterationCount++;
        if (iterationCount % 12 === 1) { // Log every minute (5s * 12 = 60s)
          console.log(`⏰ Processing cycle #${iterationCount} at ${new Date().toISOString()}`);
        }
        await this.processPendingTasks();
      } catch (error) {
        console.error('❌ Error in processing loop:', error);
      }
      
      await this.sleep(this.checkInterval);
    }
  }
  
  private async processPendingTasks(): Promise<void> {
    const tasks = await this.apiClient.getPendingTasks();
    
    if (tasks.length === 0) {
      return;
    }
    
    console.log(`Processing ${tasks.length} push tasks...`);
    
    const promises = tasks.map(task => this.processTask(task));
    const results = await Promise.allSettled(promises);
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    if (failed > 0) {
      console.log(`Completed ${successful} pushes, ${failed} failed`);
    }
  }
  
  private async processTask(task: any): Promise<void> {
    assert(task.id, "Task ID required");
    assert(task.deviceToken, "Device token required");
    assert(task.notificationId, "Notification ID required");
    
    try {
      await this.pushSender.sendNotification({
        deviceToken: task.deviceToken,
        title: task.title,
        message: task.message,
        data: task.data || {}
      });
      
      console.log(`Push sent: ${task.notificationId} to ${task.deviceToken.substring(0, 8)}...`);
      
      await this.apiClient.reportPushResult({
        taskId: task.id,
        notificationId: task.notificationId,
        success: true
      });
    } catch (error: any) {
      console.error(`Push failed: ${task.notificationId}`, error.message);
      
      await this.apiClient.reportPushResult({
        taskId: task.id,
        notificationId: task.notificationId,
        success: false,
        errorMessage: error.message
      });
    }
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function main() {
  const processor = new BackgroundProcessor();
  
  process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\nShutting down gracefully...');
    process.exit(0);
  });
  
  try {
    await processor.start();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main().catch(console.error);