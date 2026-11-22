import { v4 as uuidv4 } from 'uuid';
import { getSystemDatabase } from '@/lib/infrastructure/database/connection';

/**
 * Web Push subscriptions of installed AlertTray PWAs. Each one becomes a
 * `webpush` delivery task per notification; the task's recipient is the
 * serialized subscription (see toRecipient), which is everything the worker
 * needs to encrypt and send the push.
 */

export interface ParsedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What a `webpush` delivery task carries as its recipient (JSON). */
export interface WebPushRecipient {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Public origin of the PWA (e.g. https://alerttray.example.com), for tap-through links. */
  appOrigin?: string;
}

/**
 * Browser push services. The worker POSTs to the subscription endpoint, so
 * arbitrary endpoints would let a user aim the server at internal hosts.
 */
const PUSH_SERVICE_DOMAINS = [
  'push.apple.com',             // Safari / iPhone home-screen apps (web.push.apple.com)
  'fcm.googleapis.com',         // Chrome, Edge on Android, Samsung Internet
  'android.googleapis.com',     // legacy Chrome endpoints
  'push.services.mozilla.com',  // Firefox
  'notify.windows.com'          // Edge on Windows (*.notify.windows.com)
];

/** Extra origins allowed as endpoints (comma-separated), e.g. a local fake push service in tests. */
function extraEndpointOrigins(): string[] {
  return (process.env.WEB_PUSH_EXTRA_ENDPOINT_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

export function isAllowedEndpoint(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (extraEndpointOrigins().includes(url.origin)) return true;
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function decodeKey(value: unknown, expectedLength: number): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value.replace(/\+/g, '-').replace(/\//g, '_'), 'base64url');
  return bytes.length === expectedLength ? bytes.toString('base64url') : null;
}

/** Validate a browser `PushSubscription.toJSON()`. */
export function parseWebPushSubscription(input: unknown): ParsedSubscription | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'subscription must be an object' };
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !isAllowedEndpoint(endpoint)) {
    return { error: 'subscription.endpoint is not a supported push service URL' };
  }
  const p256dh = decodeKey(keys?.p256dh, 65);
  if (!p256dh || Buffer.from(p256dh, 'base64url')[0] !== 0x04) {
    return { error: 'subscription.keys.p256dh is not a P-256 public key' };
  }
  const auth = decodeKey(keys?.auth, 16);
  if (!auth) return { error: 'subscription.keys.auth must be 16 bytes' };
  return { endpoint, p256dh, auth };
}

/** Parse the origin header of the subscribe request; null unless it is a plain http(s) origin. */
export function parseAppOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function toRecipient(sub: ParsedSubscription, appOrigin: string | null): string {
  const recipient: WebPushRecipient = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
    ...(appOrigin ? { appOrigin } : {})
  };
  return JSON.stringify(recipient);
}

/** Endpoint of a `webpush` task recipient, or null if it is not one. */
export function endpointOfRecipient(recipient: string): string | null {
  try {
    const parsed = JSON.parse(recipient) as Partial<WebPushRecipient>;
    return typeof parsed.endpoint === 'string' ? parsed.endpoint : null;
  } catch {
    return null;
  }
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  app_origin: string | null;
  device_name: string | null;
  created_at: string;
  updated_at: string;
}

export class WebPushSubscriptionService {
  /**
   * Save (or refresh) a subscription for the user. An endpoint belongs to one
   * browser install, so if it was registered by another account (someone
   * logged out and back in as a different user) it moves to this user.
   */
  static upsert(userId: string, sub: ParsedSubscription, options: { appOrigin: string | null; deviceName?: string | null }): string {
    const db = getSystemDatabase();
    try {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO web_push_subscriptions (id, user_id, endpoint, p256dh, auth, app_origin, device_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
          app_origin = COALESCE(excluded.app_origin, app_origin),
          device_name = COALESCE(excluded.device_name, device_name),
          updated_at = excluded.updated_at
      `).run(uuidv4(), userId, sub.endpoint, sub.p256dh, sub.auth, options.appOrigin,
        options.deviceName?.slice(0, 100) || null, now, now);
      const row = db.prepare('SELECT id FROM web_push_subscriptions WHERE endpoint = ?')
        .get(sub.endpoint) as { id: string };
      return row.id;
    } finally {
      db.close();
    }
  }

  /** Remove one of the user's subscriptions. False if they have no such endpoint. */
  static remove(userId: string, endpoint: string): boolean {
    const db = getSystemDatabase();
    try {
      return db.prepare('DELETE FROM web_push_subscriptions WHERE user_id = ? AND endpoint = ?')
        .run(userId, endpoint).changes > 0;
    } finally {
      db.close();
    }
  }

  /** The push service reported the subscription gone (404/410): stop sending to it. */
  static removeExpired(endpoint: string): boolean {
    const db = getSystemDatabase();
    try {
      return db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
    } finally {
      db.close();
    }
  }

  static isSubscribed(userId: string, endpoint: string): boolean {
    const db = getSystemDatabase();
    try {
      return !!db.prepare('SELECT 1 FROM web_push_subscriptions WHERE user_id = ? AND endpoint = ?').get(userId, endpoint);
    } finally {
      db.close();
    }
  }

  /** Delivery-task recipients for all of the user's subscriptions, oldest first. */
  static recipientsForUser(userId: string): string[] {
    const db = getSystemDatabase();
    try {
      const rows = db.prepare(`
        SELECT * FROM web_push_subscriptions WHERE user_id = ? ORDER BY created_at ASC
      `).all(userId) as SubscriptionRow[];
      return rows.map(row => toRecipient(row, row.app_origin));
    } finally {
      db.close();
    }
  }
}
