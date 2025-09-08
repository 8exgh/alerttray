import { Command, Event } from '@/types';
import { EventStore, assert } from './event-store';
import { v4 as uuidv4 } from 'uuid';

export class CommandBus {
  private eventStore: EventStore;
  
  constructor() {
    this.eventStore = new EventStore();
  }
  
  async dispatch(command: Command): Promise<void> {
    assert(command.userId, "User ID is required");
    assert(command.type, "Command type is required");
    
    const events = await this.handleCommand(command);
    
    if (events.length > 0) {
      await this.eventStore.appendEvents(command.userId, events);
    }
  }
  
  private async handleCommand(command: Command): Promise<Event[]> {
    switch (command.type) {
      case 'PushNotification':
        return this.handlePushNotification(command);
      case 'CompletePushTask':
        return this.handleCompletePushTask(command);
      case 'FailPushTask':
        return this.handleFailPushTask(command);
      case 'MarkNotificationRead':
        return this.handleMarkNotificationRead(command);
      case 'CreatePurpose':
        return this.handleCreatePurpose(command);
      case 'TogglePurpose':
        return this.handleTogglePurpose(command);
      case 'CreateApiKey':
        return this.handleCreateApiKey(command);
      case 'RevokeApiKey':
        return this.handleRevokeApiKey(command);
      default:
        throw new Error(`Unknown command type: ${command.type}`);
    }
  }
  
  private handlePushNotification(command: Command): Event[] {
    const { purposeId, title, message, severity, metadata, deviceTokens } = command.payload;
    const notificationId = command.aggregateId || uuidv4();
    const now = new Date();
    
    const events: Event[] = [
      {
        aggregateId: notificationId,
        aggregateType: 'Notification',
        eventType: 'NotificationPushedEvent',
        eventVersion: 1,
        eventData: {
          notificationId,
          userId: command.userId,
          purposeId,
          title,
          message,
          severity,
          metadata,
          timestamp: now
        },
        createdAt: now,
        sequenceNumber: 0
      }
    ];
    
    // Create push task for each device token
    for (const deviceToken of deviceTokens) {
      const taskId = uuidv4();
      events.push({
        aggregateId: taskId,
        aggregateType: 'PushTask',
        eventType: 'PushTaskScheduledEvent',
        eventVersion: 1,
        eventData: {
          taskId,
          notificationId,
          userId: command.userId,
          deviceToken,
          timestamp: now
        },
        createdAt: now,
        sequenceNumber: 0
      });
    }
    
    return events;
  }
  
  private handleCompletePushTask(command: Command): Event[] {
    const { taskId, notificationId } = command.payload;
    const now = new Date();
    
    return [{
      aggregateId: taskId,
      aggregateType: 'PushTask',
      eventType: 'PushTaskCompletedEvent',
      eventVersion: 1,
      eventData: {
        taskId,
        notificationId,
        deliveredAt: now,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
  
  private handleFailPushTask(command: Command): Event[] {
    const { taskId, notificationId, errorMessage } = command.payload;
    const now = new Date();
    
    return [{
      aggregateId: taskId,
      aggregateType: 'PushTask',
      eventType: 'PushTaskFailedEvent',
      eventVersion: 1,
      eventData: {
        taskId,
        notificationId,
        errorMessage,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
  
  private handleMarkNotificationRead(command: Command): Event[] {
    const { notificationId } = command.payload;
    const now = new Date();
    
    return [{
      aggregateId: notificationId,
      aggregateType: 'Notification',
      eventType: 'NotificationReadEvent',
      eventVersion: 1,
      eventData: {
        notificationId,
        userId: command.userId,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
  
  private handleCreatePurpose(command: Command): Event[] {
    const { name, description, color, icon } = command.payload;
    const purposeId = command.aggregateId || uuidv4();
    const now = new Date();
    
    return [{
      aggregateId: purposeId,
      aggregateType: 'NotificationPurpose',
      eventType: 'NotificationPurposeCreatedEvent',
      eventVersion: 1,
      eventData: {
        purposeId,
        userId: command.userId,
        name,
        description,
        color,
        icon,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
  
  private handleTogglePurpose(command: Command): Event[] {
    const { purposeId, active } = command.payload;
    const now = new Date();
    
    return [{
      aggregateId: purposeId,
      aggregateType: 'NotificationPurpose',
      eventType: active ? 'NotificationPurposeActivatedEvent' : 'NotificationPurposeDeactivatedEvent',
      eventVersion: 1,
      eventData: {
        purposeId,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
  
  private handleCreateApiKey(command: Command): Event[] {
    const { name, keyHash } = command.payload;
    const apiKeyId = command.aggregateId || uuidv4();
    const now = new Date();
    
    return [{
      aggregateId: apiKeyId,
      aggregateType: 'ApiKey',
      eventType: 'ApiKeyCreatedEvent',
      eventVersion: 1,
      eventData: {
        apiKeyId,
        userId: command.userId,
        name,
        keyHash,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
  
  private handleRevokeApiKey(command: Command): Event[] {
    const { apiKeyId } = command.payload;
    const now = new Date();
    
    return [{
      aggregateId: apiKeyId,
      aggregateType: 'ApiKey',
      eventType: 'ApiKeyRevokedEvent',
      eventVersion: 1,
      eventData: {
        apiKeyId,
        userId: command.userId,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
}