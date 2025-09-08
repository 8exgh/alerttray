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
  severity: 'low' | 'medium' | 'high' | 'critical';
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

export interface User {
  id: string;
  email: string;
  passwordHash: string;
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
  severity: 'low' | 'medium' | 'high' | 'critical';
  metadata?: Record<string, any>;
  status: 'pending' | 'delivered' | 'failed' | 'read';
  deliveredAt?: Date;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PushTask {
  id: string;
  notificationId: string;
  userId: string;
  deviceToken: string;
  title: string;
  message: string;
  data?: Record<string, any>;
  status: 'pending' | 'processing' | 'completed' | 'failed';
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