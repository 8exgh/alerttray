import { getReadModelDatabase } from '@/lib/infrastructure/database/connection';
import { Notification, NotificationPurpose, PushTask } from '@/types';
import type { NotificationRow, NotificationPurposeRow, PushTaskRow, CountResult } from '@/types/db-types';

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
      severity: row.severity as 'low' | 'medium' | 'high' | 'critical',
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
  
  async getPendingPushTasks(limit: number = 100): Promise<PushTask[]> {
    const db = getReadModelDatabase();
    
    const rows = db.prepare(`
      SELECT * FROM push_tasks 
      WHERE status = 'pending' 
      ORDER BY created_at ASC 
      LIMIT ?
    `).all(limit) as PushTaskRow[];
    
    // Update status to processing
    const updateStmt = db.prepare(`
      UPDATE push_tasks 
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
    
    return rows.map(row => ({
      id: row.id,
      notificationId: row.notification_id,
      userId: row.user_id,
      deviceToken: row.device_token,
      title: row.title,
      message: row.message,
      data: row.data ? JSON.parse(row.data) : undefined,
      status: 'processing' as const,
      attempts: row.attempts,
      lastAttemptAt: new Date(now),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      errorMessage: row.error_message || undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }
  
  async getPushTaskById(taskId: string): Promise<PushTask | null> {
    const db = getReadModelDatabase();
    
    const row = db.prepare(`
      SELECT * FROM push_tasks WHERE id = ?
    `).get(taskId) as PushTaskRow | undefined;
    
    db.close();
    
    if (!row) return null;
    
    return {
      id: row.id,
      notificationId: row.notification_id,
      userId: row.user_id,
      deviceToken: row.device_token,
      title: row.title,
      message: row.message,
      data: row.data ? JSON.parse(row.data) : undefined,
      status: row.status as 'pending' | 'processing' | 'completed' | 'failed',
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