import addressparser from 'nodemailer/lib/addressparser';

// Operator-managed list. Keep this in the worker, never in client code or APIs.
const DO_NOT_EMAIL = new Set([
  '2907618125@qq.com'
]);

export function emailRecipients(recipient: string): string[] {
  return addressparser(recipient, { flatten: true }).map(({ address }) => address.trim().toLowerCase()).filter(Boolean);
}

/** Extra addresses can be configured on the worker without editing this list. */
export function isEmailSuppressed(recipient: string): boolean {
  const suppressed = new Set([
    ...DO_NOT_EMAIL,
    ...(process.env.EMAIL_SUPPRESSION_LIST || '')
      .split(/[\s,;]+/)
      .map(address => address.trim().toLowerCase())
      .filter(Boolean)
  ]);

  // Use the sender's parser so display names, groups and address lists cannot
  // bypass the check. Suppress the entire message if any recipient is blocked.
  return emailRecipients(recipient).some(address => suppressed.has(address));
}
