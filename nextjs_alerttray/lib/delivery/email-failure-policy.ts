/** Recipient failures that justify stopping future sends, not just this message.
 * https://www.iana.org/assignments/smtp-enhanced-status-codes/
 */
export function isPermanentRecipientFailure(status: string): boolean {
  return ['5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10', '5.2.1'].includes(status);
}

export interface EmailRecipientFailure {
  recipient: string;
  status: string;
  diagnostic: string;
}

export function parseEmailRecipientFailure(input: unknown): EmailRecipientFailure | null {
  if (!input || typeof input !== 'object') return null;
  const { recipient, status, diagnostic } = input as Record<string, unknown>;
  if (typeof recipient !== 'string' || recipient.length > 320 ||
      !/^[^\s<>@]+@[^\s<>@]+$/.test(recipient) ||
      typeof status !== 'string' || !/^5\.\d{1,3}\.\d{1,3}$/.test(status) ||
      typeof diagnostic !== 'string' || diagnostic.length > 1000) return null;
  return { recipient: recipient.toLowerCase(), status,
    diagnostic: diagnostic.replace(/[\x00-\x1f\x7f]/g, ' ') };
}
