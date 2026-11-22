import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { endpointOfRecipient, WebPushSubscriptionService } from '@/lib/web-push/subscriptions';
import { initializeSystem } from '@/lib/startup';

/**
 * Send a test notification to the user's PWA installs only (no call, SMS,
 * email or APNS). Body: { endpoint? } limits it to that one install.
 * It goes through the normal pipeline, so it also shows up in the inbox.
 */
export async function POST(request: NextRequest) {
  await initializeSystem();
  
  const session = await validateRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  
  let endpoint: string | null = null;
  try {
    const body = await request.json();
    if (typeof body?.endpoint === 'string') endpoint = body.endpoint;
  } catch { /* empty body: all installs */ }
  
  const recipients = WebPushSubscriptionService.recipientsForUser(session.user.id)
    .filter(recipient => !endpoint || endpointOfRecipient(recipient) === endpoint);
  if (recipients.length === 0) {
    return NextResponse.json(
      { error: endpoint ? 'This device is not subscribed' : 'No device has notifications enabled' },
      { status: 400 }
    );
  }
  
  const notificationId = uuidv4();
  await new CommandBus().dispatch({
    userId: session.user.id,
    aggregateId: notificationId,
    type: 'PushNotification',
    payload: {
      purposeId: 'alerttray-test',
      title: 'AlertTray test',
      message: `Notifications are working. Sent ${new Date().toUTCString()}.`,
      severity: 'low',
      metadata: { test: true },
      deliveries: recipients.map(recipient => ({ channel: 'webpush', recipient }))
    }
  });
  
  return NextResponse.json({ success: true, notificationId, devices: recipients.length });
}
