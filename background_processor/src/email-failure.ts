import { emailRecipients } from './email-suppression';

export interface EmailRecipientFailure {
  recipient: string;
  status: string;
  diagnostic: string;
}

/** Only an explicit RCPT TO rejection identifies a recipient failure.
 * AUTH, MAIL FROM, DATA, connection errors and unclassified 550s are not enough.
 * The backend decides which enhanced statuses justify permanent suppression.
 */
export function smtpRecipientFailure(error: unknown, recipient: string): EmailRecipientFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const failure = error as Record<string, unknown>;
  const recipients = emailRecipients(recipient);
  if (recipients.length !== 1 || failure.command !== 'RCPT TO' ||
      typeof failure.responseCode !== 'number' || failure.responseCode < 500 || failure.responseCode >= 600 ||
      typeof failure.response !== 'string') return undefined;
  const status = /^5\d{2}[ -]+(5\.\d{1,3}\.\d{1,3})(?:\s|$)/m.exec(failure.response)?.[1];
  if (!status) return undefined;
  return {
    recipient: recipients[0], status,
    diagnostic: failure.response.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000)
  };
}
