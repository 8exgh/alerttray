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
  
  async getDeliveryTasksForNotification(notificationId: string): Promise<DeliveryTask[]> {
    const db = getReadModelDatabase();
    
    const rows = db.prepare(`
      SELECT * FROM delivery_tasks WHERE notification_id = ? ORDER BY created_at ASC
    `).all(notificationId) as DeliveryTaskRow[];
    
    db.close();
    
    return rows.map(row => this.mapDeliveryTask(row));
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