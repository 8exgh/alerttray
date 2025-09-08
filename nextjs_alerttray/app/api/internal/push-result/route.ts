import { NextRequest } from 'next/server';
import { withInternalAuth, createInternalResponse, verifySignature } from '@/lib/infrastructure/security/api-security';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { QueryBus } from '@/lib/cqrs/query-bus';
import { initializeSystem } from '@/lib/startup';

export async function POST(request: NextRequest) {
  await initializeSystem();
  
  return withInternalAuth(request, async (req) => {
    try {
      const bodyText = await req.text();
      const signature = req.headers.get('X-Signature');
      
      // Verify signature
      if (!signature || !verifySignature(bodyText, signature)) {
        return createInternalResponse({
          error: 'Invalid signature'
        });
      }
      
      const body = JSON.parse(bodyText);
      const { taskId, notificationId, success, errorMessage } = body;
      
      if (!taskId || !notificationId || typeof success !== 'boolean') {
        return createInternalResponse({
          error: 'Missing required fields'
        });
      }
      
      // Get task details from read model
      const queryBus = new QueryBus();
      const task = await queryBus.getPushTaskById(taskId);
      
      if (!task) {
        return createInternalResponse({ error: 'Task not found' });
      }
      
      const commandBus = new CommandBus();
      
      await commandBus.dispatch({
        userId: task.userId,
        aggregateId: notificationId,
        type: success ? 'CompletePushTask' : 'FailPushTask',
        payload: {
          taskId,
          notificationId,
          errorMessage
        }
      });
      
      return createInternalResponse({ success: true });
    } catch (error) {
      console.error('Push result error:', error);
      return createInternalResponse({
        error: 'Failed to update push result'
      });
    }
  });
}