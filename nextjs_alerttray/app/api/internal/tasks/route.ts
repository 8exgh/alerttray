import { NextRequest } from 'next/server';
import { withInternalAuth, createInternalResponse } from '@/lib/infrastructure/security/api-security';
import { QueryBus } from '@/lib/cqrs/query-bus';
import { initializeSystem } from '@/lib/startup';

/**
 * Background processor polls this for pending delivery tasks across all
 * channels (apns, call, sms, email). Returned tasks are atomically marked
 * 'processing' so they are handed out exactly once.
 */
export async function GET(request: NextRequest) {
  await initializeSystem();
  
  return withInternalAuth(request, async () => {
    try {
      const queryBus = new QueryBus();
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
