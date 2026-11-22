import { getReadModelDatabase } from '@/lib/infrastructure/database/connection';
import { Notification, NotificationPurpose, DeliveryTask, DeliveryTaskStatus, Severity, Channel } from '@/types';
import type { NotificationRow, NotificationPurposeRow, DeliveryTaskRow, CountResult } from '@/types/db-types';

export class QueryBus {
  async getNotifications(userId: string, limit: number = 50): Promise<Notification[]> {
    const db = getReadModelDatabase();
    
    const rows = db.prepare(`
      SELECT * FROM notifications 
      WHERE user_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `).all(userId, limit) as NotificationRow[];
    
    db.close();
    
    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      purposeId: row.purpose_id,
      title: row.title,
      message: row.message,
      severity: row.severity as Severity,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status as 'pending' | 'delivered' | 'failed' | 'read',
      deliveredAt: row.delivered_at ? new Date(row.delivered_at) : undefined,
      readAt: row.read_at ? new Date(row.read_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }
  
  /**
   * One page of the user's notification history, newest first, for the PWA
   * inbox. `before` is the opaque cursor returned as `nextCursor` by the
   * previous page; null when there is nothing older.
   */
  async getNotificationsPage(
    userId: string,
    options: { limit?: number; before?: string | null; unreadOnly?: boolean } = {}
  ): Promise<{ notifications: Notification[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 30), 1), 100);
    const cursor = options.before ? decodeNotificationCursor(options.before) : null;
    const db = getReadModelDatabase();
    try {
      const rows = db.prepare(`
        SELECT * FROM notifications
        WHERE user_id = ?
          AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
          AND (? = 0 OR status != 'read')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(
        userId,
        cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null,
        options.unreadOnly ? 1 : 0,
        limit + 1
      ) as NotificationRow[];
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        notifications: page.map(row => this.mapNotification(row)),
        nextCursor: rows.length > limit && last ? encodeNotificationCursor(last.created_at, last.id) : null
      };
    } finally {
      db.close();
    }
  }
  
  async getNotificationForUser(userId: string, notificationId: string): Promise<Notification | null> {
    const db = getReadModelDatabase();
    try {
      const row = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?')
        .get(notificationId, userId) as NotificationRow | undefined;
      return row ? this.mapNotification(row) : null;
    } finally {
      db.close();
    }
  }
  
  private mapNotification(row: NotificationRow): Notification {
    return {
      id: row.id,
      userId: row.user_id,
      purposeId: row.purpose_id,
      title: row.title,
      message: row.message,
      severity: row.severity as Severity,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status as Notification['status'],
      deliveredAt: row.delivered_at ? new Date(row.delivered_at) : undefined,
      readAt: row.read_at ? new Date(row.read_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
  
  /**
   * Read-your-writes for the inbox: wait (bounded) until the projection has
   * applied a read command, so the response and the next fetch agree with
   * what the user just did. Returns false on timeout (the change still
   * lands with the next projection pass).
   */
  async waitUntilRead(userId: string, target: { notificationId: string } | { upTo: string }, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const db = getReadModelDatabase();
      let pending: number;
      try {
        pending = 'notificationId' in target
          ? (db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE id = ? AND user_id = ? AND status != 'read'`)
              .get(target.notificationId, userId) as CountResult).count
          : (db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND status != 'read' AND created_at <= ?`)
              .get(userId, target.upTo) as CountResult).count;
      } finally {
        db.close();
      }
      if (pending === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  
  async getPurposes(userId: string): Promise<NotificationPurpose[]> {
    const db = getReadModelDatabase();
    
    const rows = db.prepare(`
      SELECT * FROM notification_purposes 
      WHERE user_id = ? 
      ORDER BY created_at DESC
    `).all(userId) as NotificationPurposeRow[];
    
    db.close();
    
    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      description: row.description || undefined,
      color: row.color || undefined,
      icon: row.icon || undefined,
      active: Boolean(row.active),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }
  
  /**
   * Claim a batch of pending delivery tasks for the background processor.
   * Claimed tasks move to 'processing' so a concurrent poll cannot send the
   * same call/sms/email twice (the phone gateway has no idempotency key).
   */
  async getPendingDeliveryTasks(limit: number = 100): Promise<DeliveryTask[]> {
    const db = getReadModelDatabase();
    
    const rows = db.prepare(`
      SELECT * FROM delivery_tasks 
      WHERE status = 'pending' 
      ORDER BY created_at ASC 
      LIMIT ?
    `).all(limit) as DeliveryTaskRow[];
    
    // Update status to processing
    const updateStmt = db.prepare(`
      UPDATE delivery_tasks 
      SET status = 'processing', last_attempt_at = ?, updated_at = ?
      WHERE id = ?
    `);
    
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const row of rows) {
        updateStmt.run(now, now, row.id);
      }
    })();
    
    db.close();
    
    return rows.map(row => this.mapDeliveryTask({ ...row, status: 'processing', last_attempt_at: now }));
  }
  
  async getDeliveryTaskById(taskId: string): Promise<DeliveryTask | null> {
    const db = getReadModelDatabase();
    
    const row = db.prepare(`
      SELECT * FROM delivery_tasks WHERE id = ?
    `).get(taskId) as DeliveryTaskRow | undefined;
    
    db.close();
    
    return row ? this.mapDeliveryTask(row) : null;
  }

  async getEmailTaskByMessageId(messageId: string, recipient: string): Promise<DeliveryTask | null> {
    const db = getReadModelDatabase();
    try {
      const row = db.prepare(`
        SELECT * FROM delivery_tasks WHERE channel = 'email'
          AND provider_message_id = ? AND lower(trim(recipient)) = ?
      `).get(messageId, recipient.trim().toLowerCase()) as DeliveryTaskRow | undefined;
      return row ? this.mapDeliveryTask(row) : null;
    } finally { db.close(); }
  }
  
  async getDeliveryTasksForNotification(notificationId: string): Promise<DeliveryTask[]> {
    const db = getReadModelDatabase();
    
    const rows = db.prepare(`
      SELECT * FROM delivery_tasks WHERE notification_id = ? ORDER BY created_at ASC
    `).all(notificationId) as DeliveryTaskRow[];
    
    db.close();
    
    return rows.map(row => this.mapDeliveryTask(row));
  }
  
  /**
   * Tasks claimed by a processor that never reported back (crashed mid-send,
   * or an out-of-date processor that cannot handle the task) would otherwise
   * sit in 'processing' forever. After a generous timeout — a voice call can
   * legitimately take a few minutes — un-claim them so they are handed out
   * again. Tasks that have already been handed out MAX_ATTEMPTS times are
   * returned instead so the caller can fail them through the event stream.
   */
  async reclaimStaleTasks(): Promise<{ requeued: number; abandoned: DeliveryTask[] }> {
    const STALE_AFTER_MS = 15 * 60 * 1000;
    const MAX_ATTEMPTS = 3;
    const db = getReadModelDatabase();
    const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
    const now = new Date().toISOString();
    
    const stale = db.prepare(`
      SELECT * FROM delivery_tasks WHERE status = 'processing' AND last_attempt_at < ?
    `).all(cutoff) as DeliveryTaskRow[];
    
    const requeue = db.prepare(`
      UPDATE delivery_tasks
      SET status = 'pending', attempts = attempts + 1, updated_at = ?,
          error_message = 'requeued: no result reported within 15 minutes'
      WHERE id = ? AND status = 'processing'
    `);
    
    const abandoned: DeliveryTask[] = [];
    let requeued = 0;
    db.transaction(() => {
      for (const row of stale) {
        if (row.attempts + 1 < MAX_ATTEMPTS) {
          requeued += requeue.run(now, row.id).changes;
        } else {
          abandoned.push(this.mapDeliveryTask(row));
        }
      }
    })();
    
    db.close();
    
    if (requeued || abandoned.length) {
      console.warn(`⚠️  delivery tasks stuck in processing: requeued ${requeued}, abandoned ${abandoned.length}`);
    }
    return { requeued, abandoned };
  }
  
  private mapDeliveryTask(row: DeliveryTaskRow): DeliveryTask {
    return {
      id: row.id,
      notificationId: row.notification_id,
      userId: row.user_id,
      channel: row.channel as Channel,
      recipient: row.recipient,
      title: row.title,
      message: row.message,
      severity: row.severity as Severity,
      data: row.data ? JSON.parse(row.data) : undefined,
      status: row.status as DeliveryTaskStatus,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      errorMessage: row.error_message || undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
  
  async getUnreadCount(userId: string): Promise<number> {
    const db = getReadModelDatabase();
    
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM notifications 
      WHERE user_id = ? AND status != 'read'
    `).get(userId) as CountResult;
    
    db.close();
    
    return result.count;
  }
}


function encodeNotificationCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

/** Null for anything that is not a cursor we issued (treated as "first page"). */
function decodeNotificationCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string') {
      return { createdAt: value[0], id: value[1] };
    }
  } catch { /* fall through */ }
  return null;
}
