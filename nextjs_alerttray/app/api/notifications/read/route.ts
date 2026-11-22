import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { QueryBus } from '@/lib/cqrs/query-bus';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { initializeSystem } from '@/lib/startup';

/**
 * Mark notifications read. Body: { notificationId } for one, or
 * { all: true, upTo? } for everything received up to `upTo` (default now).
 */
export async function POST(request: NextRequest) {
  await initializeSystem();
  
  const session = await validateRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  
  let body: { notificationId?: unknown; all?: unknown; upTo?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  
  const commandBus = new CommandBus();
  const userId = session.user.id;
  
  if (body.all === true) {
    let upTo: string | undefined;
    if (body.upTo !== undefined) {
      if (typeof body.upTo !== 'string' || Number.isNaN(Date.parse(body.upTo))) {
        return NextResponse.json({ error: 'upTo must be an ISO timestamp' }, { status: 400 });
      }
      upTo = new Date(body.upTo).toISOString();
    }
    upTo ??= new Date().toISOString();
    await commandBus.dispatch({ userId, aggregateId: userId, type: 'MarkAllNotificationsRead', payload: { upTo } });
    await new QueryBus().waitUntilRead(userId, { upTo });
    return NextResponse.json({ success: true });
  }
  
  if (typeof body.notificationId !== 'string' || !body.notificationId) {
    return NextResponse.json({ error: 'notificationId or all: true is required' }, { status: 400 });
  }
  
  const queryBus = new QueryBus();
  const notification = await queryBus.getNotificationForUser(userId, body.notificationId);
  if (!notification) {
    return NextResponse.json({ error: 'Notification not found' }, { status: 404 });
  }
  if (notification.status !== 'read') {
    await commandBus.dispatch({
      userId,
      aggregateId: notification.id,
      type: 'MarkNotificationRead',
      payload: { notificationId: notification.id }
    });
    await queryBus.waitUntilRead(userId, { notificationId: notification.id });
  }
  return NextResponse.json({ success: true });
}
