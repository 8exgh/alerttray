import { Event } from '@/types';
import { EventStore } from './event-store';
import { getReadModelDatabase, getAllUserIds } from '@/lib/infrastructure/database/connection';
import { v4 as uuidv4 } from 'uuid';

export class ProjectionEngine {
  private checkInterval = 1000; // 1 second
  private intervalId: NodeJS.Timeout | null = null;
  private eventStore: EventStore;
  
  constructor() {
    this.eventStore = new EventStore();
  }
  
  async start(): Promise<void> {
    if (this.intervalId) return;
    
    this.intervalId = setInterval(async () => {
      try {
        await this.processProjections();
      } catch (error) {
        console.error('Error processing projections:', error);
      }
    }, this.checkInterval);
    
    await this.processProjections();
  }
  
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
  
  private async processProjections(): Promise<void> {
    const userIds = getAllUserIds();
    
    for (const userId of userIds) {
      try {
        await this.processUserEvents(userId);
      } catch (error) {
        console.error(`Error processing events for user ${userId}:`, error);
      }
    }
  }
  
  private async processUserEvents(userId: string): Promise<void> {
    const db = getReadModelDatabase();
    
    const checkpointRow = db.prepare(
      'SELECT last_processed_sequence FROM projection_checkpoints WHERE user_id = ?'
    ).get(userId) as { last_processed_sequence: number } | undefined;
    
    const lastProcessedSequence = checkpointRow?.last_processed_sequence || 0;
    
    const events = await this.eventStore.getEvents(userId, lastProcessedSequence);
    
    if (events.length === 0) {
      db.close();
      return;
    }
    
    const updateCheckpoint = db.prepare(`
      INSERT INTO projection_checkpoints (user_id, last_processed_sequence, last_processed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        last_processed_sequence = excluded.last_processed_sequence,
        last_processed_at = excluded.last_processed_at
    `);
    
    db.transaction(() => {
      for (const event of events) {
        this.projectEvent(db, event, userId);
      }
      
      const maxSequence = Math.max(...events.map(e => e.sequenceNumber));
      updateCheckpoint.run(userId, maxSequence, new Date().toISOString());
    })();
    
    db.close();
  }
  
  private projectEvent(db: any, event: Event, userId: string): void {
    switch (event.eventType) {
      case 'NotificationPushedEvent':
        this.projectNotificationPushed(db, event, userId);
        break;
      case 'PushTaskScheduledEvent':
        this.projectPushTaskScheduled(db, event);
        break;
      case 'PushTaskCompletedEvent':
        this.projectPushTaskCompleted(db, event);
        break;
      case 'PushTaskFailedEvent':
        this.projectPushTaskFailed(db, event);
        break;
      case 'NotificationReadEvent':
        this.projectNotificationRead(db, event);
        break;
      case 'NotificationPurposeCreatedEvent':
        this.projectPurposeCreated(db, event, userId);
        break;
      case 'NotificationPurposeActivatedEvent':
        this.projectPurposeActivated(db, event);
        break;
      case 'NotificationPurposeDeactivatedEvent':
        this.projectPurposeDeactivated(db, event);
        break;
      case 'DeviceRegisteredEvent':
        this.projectDeviceRegistered(db, event, userId);
        break;
      case 'DeviceUnregisteredEvent':
        this.projectDeviceUnregistered(db, event);
        break;
    }
  }
  
  private projectNotificationPushed(db: any, event: Event, userId: string): void {
    const { notificationId, purposeId, title, message, severity, metadata } = event.eventData;
    
    const insert = db.prepare(`
      INSERT INTO notifications (
        id, user_id, purpose_id, title, message, 
        severity, metadata, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    
    const now = new Date().toISOString();
    insert.run(
      notificationId, userId, purposeId, title, message,
      severity, JSON.stringify(metadata || {}), now, now
    );
  }
  
  private projectPushTaskScheduled(db: any, event: Event): void {
    const { taskId, notificationId, userId, deviceToken } = event.eventData;
    
    // Get notification details
    const notification = db.prepare(
      'SELECT title, message FROM notifications WHERE id = ?'
    ).get(notificationId) as any;
    
    if (!notification) return;
    
    const insert = db.prepare(`
      INSERT INTO push_tasks (
        id, notification_id, user_id, device_token, 
        title, message, data, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    
    const now = new Date().toISOString();
    insert.run(
      taskId, notificationId, userId, deviceToken,
      notification.title, notification.message,
      JSON.stringify({ notificationId }), now, now
    );
  }
  
  private projectPushTaskCompleted(db: any, event: Event): void {
    const { taskId, notificationId, deliveredAt } = event.eventData;
    
    const updateTask = db.prepare(`
      UPDATE push_tasks 
      SET status = 'completed', completed_at = ?, updated_at = ?
      WHERE id = ?
    `);
    
    const now = new Date().toISOString();
    updateTask.run(deliveredAt, now, taskId);
    
    // Check if all tasks for this notification are completed
    const pendingTasks = db.prepare(
      'SELECT COUNT(*) as count FROM push_tasks WHERE notification_id = ? AND status = ?'
    ).get(notificationId, 'pending') as { count: number };
    
    if (pendingTasks.count === 0) {
      const updateNotification = db.prepare(`
        UPDATE notifications 
        SET status = 'delivered', delivered_at = ?, updated_at = ?
        WHERE id = ?
      `);
      updateNotification.run(deliveredAt, now, notificationId);
    }
  }
  
  private projectPushTaskFailed(db: any, event: Event): void {
    const { taskId, notificationId, errorMessage } = event.eventData;
    
    const updateTask = db.prepare(`
      UPDATE push_tasks 
      SET status = 'failed', error_message = ?, updated_at = ?, attempts = attempts + 1
      WHERE id = ?
    `);
    
    const now = new Date().toISOString();
    updateTask.run(errorMessage, now, taskId);
    
    // Check if all tasks for this notification have failed
    const failedTasks = db.prepare(
      'SELECT COUNT(*) as count FROM push_tasks WHERE notification_id = ? AND status = ?'
    ).get(notificationId, 'failed') as { count: number };
    
    const totalTasks = db.prepare(
      'SELECT COUNT(*) as count FROM push_tasks WHERE notification_id = ?'
    ).get(notificationId) as { count: number };
    
    if (failedTasks.count === totalTasks.count) {
      const updateNotification = db.prepare(`
        UPDATE notifications 
        SET status = 'failed', updated_at = ?
        WHERE id = ?
      `);
      updateNotification.run(now, notificationId);
    }
  }
  
  private projectNotificationRead(db: any, event: Event): void {
    const { notificationId } = event.eventData;
    
    const update = db.prepare(`
      UPDATE notifications 
      SET status = 'read', read_at = ?, updated_at = ?
      WHERE id = ?
    `);
    
    const now = new Date().toISOString();
    update.run(now, now, notificationId);
  }
  
  private projectPurposeCreated(db: any, event: Event, userId: string): void {
    const { purposeId, name, description, color, icon } = event.eventData;
    
    const insert = db.prepare(`
      INSERT INTO notification_purposes (
        id, user_id, name, description, color, icon, 
        active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    
    const now = new Date().toISOString();
    insert.run(
      purposeId, userId, name, description, color, icon, now, now
    );
  }
  
  private projectPurposeActivated(db: any, event: Event): void {
    const { purposeId } = event.eventData;
    
    const update = db.prepare(`
      UPDATE notification_purposes 
      SET active = 1, updated_at = ?
      WHERE id = ?
    `);
    
    update.run(new Date().toISOString(), purposeId);
  }
  
  private projectPurposeDeactivated(db: any, event: Event): void {
    const { purposeId } = event.eventData;
    
    const update = db.prepare(`
      UPDATE notification_purposes 
      SET active = 0, updated_at = ?
      WHERE id = ?
    `);
    
    update.run(new Date().toISOString(), purposeId);
  }
  
  private projectDeviceRegistered(db: any, event: Event, userId: string): void {
    const { deviceId, token, deviceName, platform } = event.eventData;
    
    // Device is already registered in system database by the API endpoint
    // Here we need to check for pending notifications without push tasks
    
    // Find all notifications for this user that don't have push tasks for this device
    const pendingNotifications = db.prepare(`
      SELECT n.* FROM notifications n
      WHERE n.user_id = ? 
      AND n.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM push_tasks pt 
        WHERE pt.notification_id = n.id 
        AND pt.device_token = ?
      )
    `).all(userId, token) as any[];
    
    // Create push tasks for each pending notification
    const insertPushTask = db.prepare(`
      INSERT INTO push_tasks (
        id, notification_id, user_id, device_token, 
        title, message, data, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    
    const now = new Date().toISOString();
    for (const notification of pendingNotifications) {
      const taskId = uuidv4();
      insertPushTask.run(
        taskId,
        notification.id,
        userId,
        token,
        notification.title,
        notification.message,
        JSON.stringify({ notificationId: notification.id }),
        now,
        now
      );
    }
  }
  
  private projectDeviceUnregistered(db: any, event: Event): void {
    const { deviceId } = event.eventData;
    
    // We don't need to do anything here for the read model
    // The system database handles the actual device removal
    // Push tasks that were already created will remain and can fail naturally
  }
}