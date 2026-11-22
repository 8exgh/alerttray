import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { parseAppOrigin, parseWebPushSubscription, WebPushSubscriptionService } from '@/lib/web-push/subscriptions';

/**
 * Register this browser/PWA install for Web Push.
 * Body: { subscription: PushSubscription.toJSON(), deviceName? }
 * Idempotent: the PWA re-sends its subscription on every open.
 */
export async function POST(request: NextRequest) {
  const session = await validateRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  
  let body: { subscription?: unknown; deviceName?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  
  const parsed = parseWebPushSubscription(body.subscription);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  
  const id = WebPushSubscriptionService.upsert(session.user.id, parsed, {
    appOrigin: parseAppOrigin(request.headers.get('origin')) ?? parseAppOrigin(request.nextUrl.origin),
    deviceName: typeof body.deviceName === 'string' ? body.deviceName : null
  });
  
  return NextResponse.json({ success: true, subscriptionId: id });
}
