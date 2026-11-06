import { QueryBus } from '@/lib/cqrs/query-bus';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { parseEmailRecipientFailure } from './email-failure-policy';
import { suppressEmailAfterFailure } from './email-suppressions';

export interface EmailBounceReport {
  originalMessageId: string;
  recipient: string;
  status: string;
  diagnostic: string;
}

export function parseEmailBounceReport(input: unknown): EmailBounceReport | null {
  if (!input || typeof input !== 'object') return null;
  const report = input as Record<string, unknown>;
  const { originalMessageId } = report;
  const failure = parseEmailRecipientFailure(report);
  if (typeof originalMessageId !== 'string' || originalMessageId.length > 998 ||
      !/^<[^<>\s]+@[^<>\s]+>$/.test(originalMessageId) ||
      !failure) return null;
  return { originalMessageId, ...failure };
}

export async function recordEmailBounce(report: EmailBounceReport): Promise<boolean> {
  // Match both the exact SMTP message ID and recipient. The mailbox can be
  // shared with other applications; their bounces must never affect our tasks.
  const task = await new QueryBus().getEmailTaskByMessageId(report.originalMessageId, report.recipient);
  if (!task) return false;
  // Commit the block before acknowledging the bounce, without waiting for the
  // asynchronous projection. A failed write makes the monitor retry the report.
  suppressEmailAfterFailure(report, task.id);
  await new CommandBus().dispatch({
    userId: task.userId,
    aggregateId: task.id,
    type: 'RecordEmailBounce',
    payload: { ...report, taskId: task.id, notificationId: task.notificationId }
  });
  return true;
}
