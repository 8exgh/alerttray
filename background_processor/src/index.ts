import * as dotenv from 'dotenv';
import { ApiClient, type DeliveryTask } from './api-client';
import { DeliveryDispatcher, mask } from './delivery-dispatcher';

dotenv.config();

function assert(condition: any, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

class BackgroundProcessor {
  private checkInterval = 5000; // Check every 5 seconds
  private apiClient: ApiClient;
  private dispatcher: DeliveryDispatcher;
  /** Tasks currently being delivered (a voice call can take minutes). */
  private inFlight = new Set<string>();
  
  constructor() {
    this.apiClient = new ApiClient();
    this.dispatcher = new DeliveryDispatcher();
  }
  
  async start(): Promise<void> {
    console.log('🚀 Background processor started');
    console.log(`  - API URL: ${process.env.ALERTTRAY_API_URL || 'http://localhost:3000'}`);
    console.log(`  - Check interval: ${this.checkInterval}ms`);
    console.log(`  - Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`  - API_KEY present: ${process.env.API_KEY ? 'Yes' : 'No'}`);
    console.log(`  - Phone gateway: ${process.env.PHONE_GATEWAY_URL || 'https://phone-gateway.fusenv.com'} (key: ${process.env.PHONE_GATEWAY_API_KEY ? 'Yes' : 'No'})`);
    console.log(`  - Email (GMAIL_USER): ${process.env.GMAIL_USER ? 'Yes' : 'No'}`);
    
    let iterationCount = 0;
    
    while (true) {
      try {
        iterationCount++;
        if (iterationCount % 12 === 1) { // Log every minute (5s * 12 = 60s)
          console.log(`⏰ Processing cycle #${iterationCount} at ${new Date().toISOString()} (${this.inFlight.size} in flight)`);
        }
        // Claim the next batch and deliver it without blocking the poll loop:
        // a phone call can take minutes and must not hold up SMS/email for
        // other notifications. The server hands each task out exactly once,
        // so overlapping batches never double-send.
        const tasks = await this.apiClient.getPendingTasks();
        if (tasks.length > 0) {
          console.log(`Processing ${tasks.length} delivery task(s)...`);
          for (const task of tasks) {
            this.processTask(task).catch(error =>
              console.error(`❌ Unhandled error delivering task ${task.id}:`, error)
            );
          }
        }
      } catch (error) {
        console.error('❌ Error in processing loop:', error);
      }
      
      await this.sleep(this.checkInterval);
    }
  }
  
  private async processTask(task: DeliveryTask): Promise<void> {
    assert(task.id, "Task ID required");
    assert(task.channel, "Channel required");
    assert(task.recipient, "Recipient required");
    assert(task.notificationId, "Notification ID required");
    
    const label = `[${task.channel}] ${task.notificationId} → ${mask(task.recipient)}`;
    this.inFlight.add(task.id);
    
    try {
      const outcome = await this.dispatcher.dispatch(task);
      
      console.log(`✅ Delivered ${label}${outcome.providerMessageId ? ` (${outcome.providerMessageId})` : ''}`);
      
      await this.apiClient.reportResult({
        taskId: task.id,
        notificationId: task.notificationId,
        success: true,
        providerMessageId: outcome.providerMessageId
      });
    } catch (error: any) {
      console.error(`❌ Failed ${label}:`, error.message);
      
      await this.apiClient.reportResult({
        taskId: task.id,
        notificationId: task.notificationId,
        success: false,
        errorMessage: error.message
      });
    } finally {
      this.inFlight.delete(task.id);
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
