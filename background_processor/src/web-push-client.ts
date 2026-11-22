import webpush, { WebPushError } from 'web-push';
import type { Severity } from './message-format';

/** What a `webpush` delivery task carries as its recipient (JSON, written by the server). */
export interface WebPushRecipient {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  appOrigin?: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** Contact for push services (mailto: or https:), null to use the worker default. */
  subject: string | null;
}

/**
 * The push service says the subscription no longer exists (HTTP 404/410):
 * the PWA was deleted, notifications were turned off, or the subscription
 * expired. The server deletes it when told (webPushSubscriptionExpired).
 */
export class WebPushSubscriptionExpiredError extends Error {
  constructor(readonly statusCode: number) {
    super(`web push subscription expired (HTTP ${statusCode})`);
    this.name = 'WebPushSubscriptionExpiredError';
  }
}

export function parseWebPushRecipient(recipient: string): WebPushRecipient {
  let parsed: Partial<WebPushRecipient>;
  try {
    parsed = JSON.parse(recipient);
  } catch {
    throw new Error('webpush recipient is not a subscription');
  }
  if (typeof parsed.endpoint !== 'string' || typeof parsed.keys?.p256dh !== 'string' || typeof parsed.keys?.auth !== 'string') {
    throw new Error('webpush recipient is missing endpoint or keys');
  }
  return parsed as WebPushRecipient;
}

type SendNotification = typeof webpush.sendNotification;

/**
 * Sends encrypted Web Push messages (RFC 8291) signed with the server's VAPID
 * key (RFC 8292). The key pair is loaded from the AlertTray backend once and
 * cached; it is re-fetched after the push service rejects our credentials,
 * in case the pair was changed on the server.
 */
export class WebPushClient {
  private vapid: VapidConfig | null = null;

  constructor(
    private loadVapid: () => Promise<VapidConfig>,
    private send: SendNotification = webpush.sendNotification.bind(webpush)
  ) {}

  async sendNotification(recipient: string, payload: string, severity: Severity): Promise<{ providerMessageId?: string }> {
    const subscription = parseWebPushRecipient(recipient);
    const vapid = this.vapid ?? (this.vapid = await this.loadVapid());

    try {
      const result = await this.send(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        payload,
        {
          vapidDetails: {
            subject: vapid.subject || defaultSubject(),
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey
          },
          // An alert that cannot be delivered within a day is no longer useful as a banner;
          // it is still in the inbox.
          TTL: 24 * 60 * 60,
          urgency: severity === 'critical' || severity === 'high' ? 'high' : 'normal',
          timeout: 15_000
        }
      );
      const headers = result.headers as Record<string, string | undefined>;
      return { providerMessageId: headers['apns-id'] ?? headers['location'] ?? undefined };
    } catch (error) {
      if (error instanceof WebPushError) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          throw new WebPushSubscriptionExpiredError(error.statusCode);
        }
        if (error.statusCode === 401 || error.statusCode === 403) {
          this.vapid = null; // maybe the server's key pair changed; reload next time
        }
        throw new Error(`web push rejected by ${new URL(subscription.endpoint).host}: HTTP ${error.statusCode} ${String(error.body ?? '').slice(0, 200)}`.trim());
      }
      throw error;
    }
  }
}

function defaultSubject(): string {
  const configured = process.env.VAPID_SUBJECT?.trim();
  if (configured) return configured;
  if (process.env.GMAIL_USER) return `mailto:${process.env.GMAIL_USER}`;
  return 'https://github.com/8exgh/alerttray';
}
