import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { WebPushSubscriptionService } from '@/lib/web-push/subscriptions';

/** Stop Web Push to one of the user's installs. Body: { endpoint } */
export async function POST(request: NextRequest) {
  const session = await validateRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  
  let body: { endpoint?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body.endpoint !== 'string' || !body.endpoint) {
    return NextResponse.json({ error: 'endpoint is required' }, { status: 400 });
  }
  
  const removed = WebPushSubscriptionService.remove(session.user.id, body.endpoint);
  return NextResponse.json({ success: true, removed });
}
