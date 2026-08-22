/**
 * Severity → delivery channel routing policy.
 *
 * This is the single place that decides which channels a notification of a
 * given severity is sent through. The background processor executes whatever
 * delivery tasks the policy produces; it never makes routing decisions itself.
 *
 * Channels:
 *   apns      - iOS push via Apple Push Notification Service (always on)
 *   call      - voice phone call via phone-call-gateway (TTS of the alert)
 *   sms       - SMS via phone-call-gateway
 *   email     - email via SMTP
 *   emergency - iPhone emergency/critical alert. Reserved: the iOS side is
 *               being built separately, so it is NOT routed yet.
 */

export const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

export const CHANNELS = ['apns', 'call', 'sms', 'email', 'emergency'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Channels routed for each severity, in addition to `apns` (which is always on). */
export const SEVERITY_CHANNEL_POLICY: Record<Severity, readonly Channel[]> = {
  // Top two levels: phone call + SMS.
  // `critical` will additionally go out as an iPhone emergency alert once the
  // iOS side lands — add 'emergency' here when that is ready.
  critical: ['call', 'sms'],
  high: ['call', 'sms'],
  // Everything else that sends a message goes by email.
  medium: ['email'],
  low: ['email'],
};

/**
 * If a routed channel cannot be used because the user has not configured the
 * contact detail it needs (e.g. no phone number for call/sms), fall back to
 * this channel so the alert still reaches them somewhere. Set to `null` to
 * disable the fallback.
 */
export const FALLBACK_CHANNEL: Channel | null = 'email';

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITY_LEVELS as readonly string[]).includes(value);
}

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

export interface UserContactDetails {
  /** E.164 phone number, e.g. +14155552671 */
  phoneNumber: string | null;
  /** Address alerts are emailed to (defaults to the account email). */
  notificationEmail: string | null;
  /** Registered APNS device tokens. */
  deviceTokens: string[];
}

export interface DeliveryTarget {
  channel: Channel;
  /** Device token, phone number or email address depending on channel. */
  recipient: string;
}

/**
 * Resolve the concrete delivery targets for a notification of the given
 * severity, given what contact details the user has configured.
 *
 * Returns the targets plus a list of channels that were routed by policy but
 * skipped because the user has no recipient configured for them.
 */
export function resolveDeliveryTargets(
  severity: Severity,
  contact: UserContactDetails
): { targets: DeliveryTarget[]; skipped: Channel[] } {
  const targets: DeliveryTarget[] = [];
  const skipped: Channel[] = [];

  for (const token of contact.deviceTokens) {
    targets.push({ channel: 'apns', recipient: token });
  }

  const wanted = new Set<Channel>(SEVERITY_CHANNEL_POLICY[severity]);
  let needsFallback = false;

  for (const channel of wanted) {
    const recipient = recipientFor(channel, contact);
    if (recipient) {
      targets.push({ channel, recipient });
    } else {
      skipped.push(channel);
      needsFallback = true;
    }
  }

  if (needsFallback && FALLBACK_CHANNEL && !wanted.has(FALLBACK_CHANNEL)) {
    const recipient = recipientFor(FALLBACK_CHANNEL, contact);
    if (recipient) {
      targets.push({ channel: FALLBACK_CHANNEL, recipient });
    }
  }

  return { targets, skipped };
}

function recipientFor(channel: Channel, contact: UserContactDetails): string | null {
  switch (channel) {
    case 'call':
    case 'sms':
      return contact.phoneNumber;
    case 'email':
      return contact.notificationEmail;
    case 'apns':
    case 'emergency':
      // Device-bound channels are expanded per token above / handled separately.
      return null;
  }
}

/** E.164 check matching the phone gateway: leading "+", 8–15 digits, no leading zero. */
export function normalizePhoneNumber(input: string): string | null {
  const stripped = input.replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(stripped) ? stripped : null;
}

export function isValidEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}
