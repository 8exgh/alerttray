import { NextRequest } from 'next/server';
import { withInternalAuth, createInternalResponse } from '@/lib/infrastructure/security/api-security';
import { getVapidKeys } from '@/lib/web-push/vapid';

/**
 * Worker-only: the VAPID key pair the background processor signs Web Push
 * with. Served from here so the PWA's subscriptions and the worker's
 * signatures always use the same pair (see lib/web-push/vapid.ts).
 */
export async function GET(request: NextRequest) {
  return withInternalAuth(request, async () => {
    try {
      const keys = getVapidKeys();
      return createInternalResponse({
        success: true,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        subject: process.env.VAPID_SUBJECT?.trim() || null
      });
    } catch (error) {
      console.error('VAPID keys unavailable:', error);
      return createInternalResponse({ error: 'Web Push is not configured on this server' });
    }
  });
}
