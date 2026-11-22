/**
 * Per-channel rendering of an alert. Kept in one place so the wording of
 * calls, texts and emails stays consistent.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface AlertContent {
  title: string;
  message: string;
  severity: Severity;
  notificationId: string;
}

const APP_NAME = process.env.ALERT_APP_NAME || 'AlertTray';

export function formatSms(alert: AlertContent): string {
  const prefix = `[${APP_NAME} ${alert.severity.toUpperCase()}]`;
  const text = `${prefix} ${alert.title}: ${alert.message}`;
  // Gateway caps SMS at 1600 chars; keep well under a few segments.
  return text.length > 1000 ? text.slice(0, 997) + '…' : text;
}

/** Spoken opening line for the voice call. */
export function formatCallOpeningLine(alert: AlertContent): string {
  const urgency = alert.severity === 'critical' ? 'This is a critical alert.' : 'This is a high priority alert.';
  return `Hello, this is ${APP_NAME}. ${urgency} ${alert.title}. ${alert.message}`;
}

/** Goal that pins the gateway's voice agent to reading the alert and hanging up. */
export function formatCallGoal(alert: AlertContent): string {
  return [
    `You are an automated alert line for ${APP_NAME}. You have just read out a ${alert.severity} alert.`,
    `Alert title: "${alert.title}". Alert message: "${alert.message}".`,
    'If asked, repeat the alert slowly and clearly. Do not invent details beyond the alert text.',
    'Ask once whether they heard the alert. As soon as they confirm, or if there is no response, say goodbye and end the call.',
    'Keep the whole call under one minute.'
  ].join(' ');
}

export function formatEmailSubject(alert: AlertContent): string {
  return `[${APP_NAME}] ${alert.severity.toUpperCase()}: ${alert.title}`;
}

export function formatEmailText(alert: AlertContent): string {
  return [
    `${alert.title}`,
    '',
    alert.message,
    '',
    `Severity: ${alert.severity}`,
    `Notification ID: ${alert.notificationId}`,
    '',
    `— ${APP_NAME}`
  ].join('\n');
}

export function formatEmailHtml(alert: AlertContent): string {
  const color: Record<Severity, string> = {
    critical: '#b91c1c',
    high: '#c2410c',
    medium: '#a16207',
    low: '#1d4ed8'
  };
  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111827; line-height: 1.5;">
    <div style="max-width: 560px; margin: 0 auto; padding: 24px;">
      <div style="display:inline-block; padding: 2px 10px; border-radius: 9999px; background: ${color[alert.severity]}; color: #fff; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;">
        ${escapeHtml(alert.severity)}
      </div>
      <h1 style="font-size: 20px; margin: 16px 0 8px;">${escapeHtml(alert.title)}</h1>
      <p style="font-size: 16px; white-space: pre-wrap; margin: 0 0 24px;">${escapeHtml(alert.message)}</p>
      <p style="font-size: 12px; color: #6b7280; margin: 0;">Notification ID: ${escapeHtml(alert.notificationId)}<br/>Sent by ${escapeHtml(APP_NAME)}</p>
    </div>
  </body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Web Push payload for the PWA (JSON, encrypted by the sender).
 *
 * Uses the Declarative Web Push shape (`web_push: 8030`), which iOS 18.4+ /
 * Safari 18.4+ display even if the service worker is not running, and which
 * the AlertTray service worker (public/sw.js) also reads on browsers without
 * declarative support. Declarative push requires an absolute `navigate`
 * URL, so without a known app origin a plain payload is sent instead.
 *
 * Text is capped so the encrypted message stays under the 4 KB Web Push
 * limit; the full alert is always in the inbox.
 */
export function formatWebPushPayload(alert: AlertContent, appOrigin?: string | null): string {
  const marker: Partial<Record<Severity, string>> = { critical: '🚨 ', high: '⚠️ ' };
  const title = clipBytes(`${marker[alert.severity] ?? ''}${alert.title}`, 300);
  const path = `/inbox?n=${encodeURIComponent(alert.notificationId)}`;
  const data = { notificationId: alert.notificationId, severity: alert.severity, url: path };

  const render = (body: string) => JSON.stringify(appOrigin
    ? {
        web_push: 8030,
        notification: { title, body, navigate: `${appOrigin}${path}`, tag: alert.notificationId, silent: false, data }
      }
    : { title, body, tag: alert.notificationId, ...data });

  // Measure the encoded JSON (multi-byte text and escapes count), shrinking the body until it fits.
  let budget = 2400;
  let payload = render(clipBytes(alert.message, budget));
  while (Buffer.byteLength(payload) > WEB_PUSH_MAX_PAYLOAD_BYTES && budget > 0) {
    budget = Math.floor(budget * 0.8) - 1;
    payload = render(clipBytes(alert.message, Math.max(budget, 0)));
  }
  return payload;
}

/** Plaintext budget: 4096-byte record minus encryption header, tag and padding, with headroom. */
const WEB_PUSH_MAX_PAYLOAD_BYTES = 3000;

/** Cut to at most `maxBytes` of UTF-8 without splitting a character; adds an ellipsis when cut. */
function clipBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const ellipsis = '…';
  let out = '';
  let used = Buffer.byteLength(ellipsis);
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out + ellipsis;
}
