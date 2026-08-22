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
