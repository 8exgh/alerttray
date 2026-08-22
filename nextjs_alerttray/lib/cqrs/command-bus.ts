import { Command, Event } from '@/types';
import { EventStore, assert } from './event-store';
import { isChannel, isSeverity, type DeliveryTarget } from '@/lib/delivery/routing-policy';
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
      case 'CompleteDeliveryTask':
        return this.handleCompleteDeliveryTask(command);
      case 'FailDeliveryTask':
        return this.handleFailDeliveryTask(command);
      case 'UpdateContactDetails':
        return this.handleUpdateContactDetails(command);
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
      case 'RegisterDevice':
        return this.handleRegisterDevice(command);
      case 'UnregisterDevice':
        return this.handleUnregisterDevice(command);
      default:
        throw new Error(`Unknown command type: ${command.type}`);
    }
  }
  
  private handlePushNotification(command: Command): Event[] {
    const { purposeId, title, message, severity, metadata } = command.payload;
    const deliveries = (command.payload.deliveries ?? []) as DeliveryTarget[];
    assert(isSeverity(severity), `Invalid severity: ${severity}`);
    
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
    
    // One delivery task per (channel, recipient) the routing policy resolved
    for (const { channel, recipient } of deliveries) {
      assert(isChannel(channel), `Invalid channel: ${channel}`);
      assert(recipient, `Recipient required for ${channel} delivery`);
      const taskId = uuidv4();
      events.push({
        aggregateId: taskId,
        aggregateType: 'DeliveryTask',
        eventType: 'DeliveryTaskScheduledEvent',
        eventVersion: 1,
        eventData: {
          taskId,
          notificationId,
          userId: command.userId,
          channel,
          recipient,
          severity,
          timestamp: now
        },
        createdAt: now,
        sequenceNumber: 0
      });
    }
    
    return events;
  }
  
  private handleCompleteDeliveryTask(command: Command): Event[] {
    const { taskId, notificationId, channel, providerMessageId } = command.payload;
    const now = new Date();
    
    return [{
      aggregateId: taskId,
      aggregateType: 'DeliveryTask',
      eventType: 'DeliveryTaskCompletedEvent',
      eventVersion: 1,
      eventData: {
        taskId,
        notificationId,
        channel,
        providerMessageId,
        deliveredAt: now,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
  
  private handleFailDeliveryTask(command: Command): Event[] {
    const { taskId, notificationId, channel, errorMessage } = command.payload;
    const now = new Date();
    
    return [{
      aggregateId: taskId,
      aggregateType: 'DeliveryTask',
      eventType: 'DeliveryTaskFailedEvent',
      eventVersion: 1,
      eventData: {
        taskId,
        notificationId,
        channel,
        errorMessage,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
  
  private handleUpdateContactDetails(command: Command): Event[] {
    const { phoneNumber = null, notificationEmail = null } = command.payload;
    const now = new Date();
    
    return [{
      aggregateId: command.userId,
      aggregateType: 'User',
      eventType: 'ContactDetailsUpdatedEvent',
      eventVersion: 1,
      eventData: {
        userId: command.userId,
        phoneNumber,
        notificationEmail,
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
  
  private handleRegisterDevice(command: Command): Event[] {
    const { token, deviceName, platform = 'ios' } = command.payload;
    const deviceId = command.aggregateId || uuidv4();
    const now = new Date();
    
    const events: Event[] = [{
      aggregateId: deviceId,
      aggregateType: 'Device',
      eventType: 'DeviceRegisteredEvent',
      eventVersion: 1,
      eventData: {
        deviceId,
        userId: command.userId,
        token,
        deviceName,
        platform,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
    
    // After registering a device, we need to check for pending notifications
    // This will be handled by the projection engine when it processes this event
    
    return events;
  }
  
  private handleUnregisterDevice(command: Command): Event[] {
    const { deviceId } = command.payload;
    const now = new Date();
    
    return [{
      aggregateId: deviceId,
      aggregateType: 'Device',
      eventType: 'DeviceUnregisteredEvent',
      eventVersion: 1,
      eventData: {
        deviceId,
        userId: command.userId,
        timestamp: now
      },
      createdAt: now,
      sequenceNumber: 0
    }];
  }
}