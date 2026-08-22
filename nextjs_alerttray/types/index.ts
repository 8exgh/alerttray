import type { Severity, Channel } from '@/lib/delivery/routing-policy';
export type { Severity, Channel } from '@/lib/delivery/routing-policy';

export interface Event {
  id?: number;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  eventVersion: number;
  eventData: Record<string, any>;
  metadata?: Record<string, any>;
  createdAt: Date;
  sequenceNumber: number;
}

export interface Command {
  userId: string;
  aggregateId: string;
  type: string;
  payload: Record<string, any>;
}

export interface NotificationPushedEvent {
  notificationId: string;
  userId: string;
  purposeId: string;
  title: string;
  message: string;
  severity: Severity;
  metadata?: Record<string, any>;
  timestamp: Date;
}

export interface PushTaskScheduledEvent {
  taskId: string;
  notificationId: string;
  userId: string;
  deviceToken: string;
  timestamp: Date;
}

export interface PushTaskCompletedEvent {
  taskId: string;
  notificationId: string;
  deliveredAt: Date;
  timestamp: Date;
}

export interface PushTaskFailedEvent {
  taskId: string;
  notificationId: string;
  errorMessage: string;
  timestamp: Date;
}

/**
 * A notification was routed to a delivery channel (push, call, sms, email).
 * Supersedes PushTaskScheduledEvent, which is kept for replaying old streams
 * and is equivalent to { channel: 'apns', recipient: deviceToken }.
 */
export interface DeliveryTaskScheduledEvent {
  taskId: string;
  notificationId: string;
  userId: string;
  channel: Channel;
  recipient: string;
  severity: Severity;
  timestamp: Date;
}

export interface DeliveryTaskCompletedEvent {
  taskId: string;
  notificationId: string;
  channel: Channel;
  deliveredAt: Date;
  /** Provider-side id (APNS id, gateway call/sms id, email message id). */
  providerMessageId?: string;
  timestamp: Date;
}

export interface DeliveryTaskFailedEvent {
  taskId: string;
  notificationId: string;
  channel: Channel;
  errorMessage: string;
  timestamp: Date;
}

export interface ContactDetailsUpdatedEvent {
  userId: string;
  phoneNumber: string | null;
  notificationEmail: string | null;
  timestamp: Date;
}

export interface NotificationReadEvent {
  notificationId: string;
  userId: string;
  timestamp: Date;
}

export interface NotificationPurposeCreatedEvent {
  purposeId: string;
  userId: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  timestamp: Date;
}

export interface NotificationPurposeActivatedEvent {
  purposeId: string;
  timestamp: Date;
}

export interface NotificationPurposeDeactivatedEvent {
  purposeId: string;
  timestamp: Date;
}

export interface ApiKeyCreatedEvent {
  apiKeyId: string;
  userId: string;
  name: string;
  keyHash: string;
  timestamp: Date;
}

export interface ApiKeyRevokedEvent {
  apiKeyId: string;
  userId: string;
  timestamp: Date;
}

export interface DeviceRegisteredEvent {
  deviceId: string;
  userId: string;
  token: string;
  deviceName?: string;
  platform: string;
  timestamp: Date;
}

export interface DeviceUnregisteredEvent {
  deviceId: string;
  userId: string;
  timestamp: Date;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  /** E.164 phone number used for call/sms alerts. */
  phoneNumber?: string | null;
  /** Address alerts are emailed to; falls back to `email` when unset. */
  notificationEmail?: string | null;
  createdAt: Date;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface ApiKey {
  id: string;
  userId: string;
  keyHash: string;
  name: string;
  lastUsedAt?: Date;
  createdAt: Date;
  revokedAt?: Date;
}

export interface DeviceToken {
  id: string;
  userId: string;
  token: string;
  deviceName?: string;
  platform: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Notification {
  id: string;
  userId: string;
  purposeId: string;
  title: string;
  message: string;
  severity: Severity;
  metadata?: Record<string, any>;
  status: 'pending' | 'delivered' | 'failed' | 'read';
  deliveredAt?: Date;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type DeliveryTaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * One unit of work for the background processor: deliver a notification to
 * one recipient over one channel.
 */
export interface DeliveryTask {
  id: string;
  notificationId: string;
  userId: string;
  channel: Channel;
  /** Device token (apns), E.164 phone number (call/sms) or email address (email). */
  recipient: string;
  title: string;
  message: string;
  severity: Severity;
  data?: Record<string, any>;
  status: DeliveryTaskStatus;
  attempts: number;
  lastAttemptAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationPurpose {
  id: string;
  userId: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}