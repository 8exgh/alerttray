import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { getVapidKeys } from '@/lib/web-push/vapid';

/** VAPID public key the PWA subscribes with (applicationServerKey). */
export async function GET(request: NextRequest) {
  const session = await validateRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  try {
    return NextResponse.json({ publicKey: getVapidKeys().publicKey });
  } catch (error) {
    console.error('Web Push is not configured:', error);
    return NextResponse.json({ error: 'Web Push is not configured on this server' }, { status: 503 });
  }
}
