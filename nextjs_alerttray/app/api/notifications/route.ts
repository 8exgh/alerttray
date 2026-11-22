import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { QueryBus } from '@/lib/cqrs/query-bus';
import { initializeSystem } from '@/lib/startup';

/**
 * The signed-in user's notification history, newest first (PWA inbox).
 * Query: ?limit=30&before=<nextCursor>&unread=1
 */
export async function GET(request: NextRequest) {
  await initializeSystem();
  
  const session = await validateRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  
  const params = request.nextUrl.searchParams;
  const limit = Number(params.get('limit') ?? 30);
  const queryBus = new QueryBus();
  const [page, unreadCount] = await Promise.all([
    queryBus.getNotificationsPage(session.user.id, {
      limit: Number.isFinite(limit) ? limit : 30,
      before: params.get('before'),
      unreadOnly: params.get('unread') === '1'
    }),
    queryBus.getUnreadCount(session.user.id)
  ]);
  
  return NextResponse.json(
    {
      notifications: page.notifications.map(n => ({
        id: n.id,
        purposeId: n.purposeId,
        title: n.title,
        message: n.message,
        severity: n.severity,
        status: n.status,
        metadata: n.metadata,
        createdAt: n.createdAt,
        deliveredAt: n.deliveredAt ?? null,
        readAt: n.readAt ?? null
      })),
      nextCursor: page.nextCursor,
      unreadCount
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
