import { Event } from '@/types';
import { EventStore } from './event-store';
import { getReadModelDatabase, getAllUserIds } from '@/lib/infrastructure/database/connection';
import { v4 as uuidv4 } from 'uuid';
import type { NotificationRow, CountResult } from '@/types/db-types';
import type { Channel } from '@/lib/delivery/routing-policy';
import type Database from 'better-sqlite3';

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
  
  private projectEvent(db: Database.Database, event: Event, userId: string): void {
    switch (event.eventType) {
      case 'NotificationPushedEvent':
        this.projectNotificationPushed(db, event, userId);
        break;
      case 'DeliveryTaskScheduledEvent':
        this.projectDeliveryTaskScheduled(db, event);
        break;
      case 'DeliveryTaskCompletedEvent':
        this.projectDeliveryTaskCompleted(db, event);
        break;
      case 'DeliveryTaskFailedEvent':
        this.projectDeliveryTaskFailed(db, event);
        break;
      // Legacy APNS-only events (streams written before multi-channel delivery)
      case 'PushTaskScheduledEvent':
        this.projectDeliveryTaskScheduled(db, {
          ...event,
          eventData: { ...event.eventData, channel: 'apns', recipient: event.eventData.deviceToken }
        });
        break;
      case 'PushTaskCompletedEvent':
        this.projectDeliveryTaskCompleted(db, event);
        break;
      case 'PushTaskFailedEvent':
        this.projectDeliveryTaskFailed(db, event);
        break;
      case 'ContactDetailsUpdatedEvent':
        // Contact details live in the system database; nothing to project.
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
        this.projectDeviceUnregistered();
        break;
    }
  }
  
  private projectNotificationPushed(db: Database.Database, event: Event, userId: string): void {
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
  
  private projectDeliveryTaskScheduled(db: Database.Database, event: Event): void {
    const { taskId, notificationId, userId, channel, recipient } = event.eventData;
    
    // Get notification details
    const notification = db.prepare(
      'SELECT title, message, severity FROM notifications WHERE id = ?'
    ).get(notificationId) as Pick<NotificationRow, 'title' | 'message' | 'severity'> | undefined;
    
    if (!notification) return;
    
    const insert = db.prepare(`
      INSERT OR IGNORE INTO delivery_tasks (
        id, notification_id, user_id, channel, recipient,
        title, message, severity, data, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    
    const now = new Date().toISOString();
    insert.run(
      taskId, notificationId, userId, channel, recipient,
      notification.title, notification.message,
      event.eventData.severity ?? notification.severity,
      JSON.stringify({ notificationId }), now, now
    );
  }
  
  private projectDeliveryTaskCompleted(db: Database.Database, event: Event): void {
    const { taskId, notificationId, deliveredAt } = event.eventData;
    
    const updateTask = db.prepare(`
      UPDATE delivery_tasks 
      SET status = 'completed', completed_at = ?, updated_at = ?
      WHERE id = ?
    `);
    
    const now = new Date().toISOString();
    updateTask.run(deliveredAt, now, taskId);
    
    // Notification is delivered once nothing is still pending or in flight
    const outstanding = db.prepare(
      "SELECT COUNT(*) as count FROM delivery_tasks WHERE notification_id = ? AND status IN ('pending', 'processing')"
    ).get(notificationId) as CountResult;
    
    if (outstanding.count === 0) {
      const updateNotification = db.prepare(`
        UPDATE notifications 
        SET status = 'delivered', delivered_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `);
      updateNotification.run(deliveredAt, now, notificationId);
    }
  }
  
  private projectDeliveryTaskFailed(db: Database.Database, event: Event): void {
    const { taskId, notificationId, errorMessage } = event.eventData;
    
    const updateTask = db.prepare(`
      UPDATE delivery_tasks 
      SET status = 'failed', error_message = ?, updated_at = ?, attempts = attempts + 1
      WHERE id = ?
    `);
    
    const now = new Date().toISOString();
    updateTask.run(errorMessage, now, taskId);
    
    // Notification only fails when every channel has failed
    const failedTasks = db.prepare(
      'SELECT COUNT(*) as count FROM delivery_tasks WHERE notification_id = ? AND status = ?'
    ).get(notificationId, 'failed') as CountResult;
    
    const totalTasks = db.prepare(
      'SELECT COUNT(*) as count FROM delivery_tasks WHERE notification_id = ?'
    ).get(notificationId) as CountResult;
    
    if (failedTasks.count === totalTasks.count) {
      const updateNotification = db.prepare(`
        UPDATE notifications 
        SET status = 'failed', updated_at = ?
        WHERE id = ? AND status = 'pending'
      `);
      updateNotification.run(now, notificationId);
    }
  }
  
  private projectNotificationRead(db: Database.Database, event: Event): void {
    const { notificationId } = event.eventData;
    
    const update = db.prepare(`
      UPDATE notifications 
      SET status = 'read', read_at = ?, updated_at = ?
      WHERE id = ?
    `);
    
    const now = new Date().toISOString();
    update.run(now, now, notificationId);
  }
  
  private projectPurposeCreated(db: Database.Database, event: Event, userId: string): void {
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
  
  private projectPurposeActivated(db: Database.Database, event: Event): void {
    const { purposeId } = event.eventData;
    
    const update = db.prepare(`
      UPDATE notification_purposes 
      SET active = 1, updated_at = ?
      WHERE id = ?
    `);
    
    update.run(new Date().toISOString(), purposeId);
  }
  
  private projectPurposeDeactivated(db: Database.Database, event: Event): void {
    const { purposeId } = event.eventData;
    
    const update = db.prepare(`
      UPDATE notification_purposes 
      SET active = 0, updated_at = ?
      WHERE id = ?
    `);
    
    update.run(new Date().toISOString(), purposeId);
  }
  
  private projectDeviceRegistered(db: Database.Database, event: Event, userId: string): void {
    const { token } = event.eventData;
    
    // Device is already registered in system database by the API endpoint
    // Here we need to check for pending notifications without push tasks
    
    // Find all notifications for this user that don't have an APNS task for this device
    const channel: Channel = 'apns';
    const pendingNotifications = db.prepare(`
      SELECT n.* FROM notifications n
      WHERE n.user_id = ? 
      AND n.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM delivery_tasks dt 
        WHERE dt.notification_id = n.id 
        AND dt.channel = ?
        AND dt.recipient = ?
      )
    `).all(userId, channel, token) as NotificationRow[];
    
    // Create push tasks for each pending notification
    const insertTask = db.prepare(`
      INSERT INTO delivery_tasks (
        id, notification_id, user_id, channel, recipient,
        title, message, severity, data, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    
    const now = new Date().toISOString();
    for (const notification of pendingNotifications) {
      const taskId = uuidv4();
      insertTask.run(
        taskId,
        notification.id,
        userId,
        channel,
        token,
        notification.title,
        notification.message,
        notification.severity,
        JSON.stringify({ notificationId: notification.id }),
        now,
        now
      );
    }
  }
  
  private projectDeviceUnregistered(): void {
    // We don't need to do anything here for the read model
    // The system database handles the actual device removal
    // Push tasks that were already created will remain and can fail naturally
  }
}