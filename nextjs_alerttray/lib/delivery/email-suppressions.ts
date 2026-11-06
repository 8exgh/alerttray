import { getSystemDatabase } from '@/lib/infrastructure/database/connection';
import { isPermanentRecipientFailure, type EmailRecipientFailure } from './email-failure-policy';

/** Global, operator-only suppression across users and workers. No expiry. */
export function suppressEmailAfterFailure(failure: EmailRecipientFailure, taskId: string): void {
  if (!isPermanentRecipientFailure(failure.status)) return;
  const db = getSystemDatabase();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO email_suppressions (recipient, status, diagnostic, source_task_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(failure.recipient.trim().toLowerCase(), failure.status, failure.diagnostic, taskId, new Date().toISOString());
  } finally { db.close(); }
}

export function hasSuppressedEmail(recipients: string[]): boolean {
  const db = getSystemDatabase();
  try {
    const lookup = db.prepare('SELECT 1 FROM email_suppressions WHERE recipient = ?');
    return recipients.some(recipient => !!lookup.get(recipient.trim().toLowerCase()));
  } finally { db.close(); }
}
