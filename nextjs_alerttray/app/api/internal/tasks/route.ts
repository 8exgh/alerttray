import { NextRequest } from 'next/server';
import { withInternalAuth, createInternalResponse } from '@/lib/infrastructure/security/api-security';
import { QueryBus } from '@/lib/cqrs/query-bus';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { initializeSystem } from '@/lib/startup';

/**
 * Background processor polls this for pending delivery tasks across all
 * channels (apns, call, sms, email). Returned tasks are atomically marked
 * 'processing' so they are handed out exactly once. Tasks whose processor
 * never reported back are re-queued first (or failed after repeated tries).
 */
export async function GET(request: NextRequest) {
  await initializeSystem();
  
  return withInternalAuth(request, async () => {
    try {
      const queryBus = new QueryBus();
      
      const { abandoned } = await queryBus.reclaimStaleTasks();
      if (abandoned.length > 0) {
        const commandBus = new CommandBus();
        for (const task of abandoned) {
          await commandBus.dispatch({
            userId: task.userId,
            aggregateId: task.id,
            type: 'FailDeliveryTask',
            payload: {
              taskId: task.id,
              notificationId: task.notificationId,
              channel: task.channel,
              errorMessage: 'abandoned: no result reported after repeated attempts'
            }
          });
        }
      }
      
      const tasks = await queryBus.getPendingDeliveryTasks();
      
      return createInternalResponse({ 
        success: true,
        tasks 
      });
    } catch (error) {
      console.error('Get tasks error:', error);
      return createInternalResponse({ 
        error: 'Failed to get tasks',
        tasks: []
      });
    }
  });
}
