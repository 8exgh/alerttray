import { NextRequest, NextResponse } from 'next/server';
import { withInternalAuth, createInternalResponse, verifySignature } from '@/lib/infrastructure/security/api-security';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { QueryBus } from '@/lib/cqrs/query-bus';
import { initializeSystem } from '@/lib/startup';
import { parseEmailRecipientFailure } from '@/lib/delivery/email-failure-policy';
import { suppressEmailAfterFailure } from '@/lib/delivery/email-suppressions';
import { endpointOfRecipient, WebPushSubscriptionService } from '@/lib/web-push/subscriptions';

/**
 * Background processor reports the outcome of a delivery task (any channel).
 * Body: { taskId, notificationId, success, errorMessage?, providerMessageId?, emailFailure?,
 *         webPushSubscriptionExpired? }
 * webPushSubscriptionExpired: the push service answered 404/410 for a webpush
 * task, i.e. the PWA was removed or its permission revoked; the subscription
 * is deleted so it is not scheduled again.
 */
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
      const { taskId, notificationId, success, errorMessage, providerMessageId, emailFailure, webPushSubscriptionExpired } = body;
      
      if (!taskId || !notificationId || typeof success !== 'boolean') {
        return createInternalResponse({
          error: 'Missing required fields'
        });
      }
      
      // Get task details from read model
      const queryBus = new QueryBus();
      const task = await queryBus.getDeliveryTaskById(taskId);
      
      if (!task || task.notificationId !== notificationId) {
        return createInternalResponse({ error: 'Task not found' });
      }

      const recipientFailure = emailFailure === undefined ? undefined : parseEmailRecipientFailure(emailFailure);
      if (emailFailure !== undefined && (!recipientFailure || success || task.channel !== 'email' ||
          recipientFailure.recipient !== task.recipient.trim().toLowerCase())) {
        return NextResponse.json({ error: 'Invalid email recipient failure' }, { status: 400 });
      }
      if (recipientFailure) suppressEmailAfterFailure(recipientFailure, task.id);
      
      if (webPushSubscriptionExpired === true && !success && task.channel === 'webpush') {
        const endpoint = endpointOfRecipient(task.recipient);
        if (endpoint && WebPushSubscriptionService.removeExpired(endpoint)) {
          console.log(`🧹 Removed expired Web Push subscription (${new URL(endpoint).host}) for user ${task.userId}`);
        }
      }
      
      const commandBus = new CommandBus();
      
      await commandBus.dispatch({
        userId: task.userId,
        aggregateId: taskId,
        type: success ? 'CompleteDeliveryTask' : 'FailDeliveryTask',
        payload: {
          taskId,
          notificationId,
          channel: task.channel,
          errorMessage,
          providerMessageId,
          emailFailure: recipientFailure
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
