# AlertTray MVP Technical Specification

## Executive Summary

AlertTray is a notification management service built with CQRS (Command Query Responsibility Segregation) and Event Sourcing patterns. Users can create API keys to push notifications through a secure API, which are queued as tasks for a background processor to send via Apple Push Notification Service (APNS) to iOS devices.

## System Architecture Overview

### High-Level Components

1. **nextjs_alerttray** (Root folder)
   - Next.js application with integrated backend
   - CQRS implementation with Event Sourcing
   - Secure API endpoints for notification ingestion
   - Internal APIs for background_processor (tasks/results)
   - Frontend UI with Tailwind CSS (1-second polling)
   - Projection engine for read model updates
   - TypeScript throughout

2. **background_processor** (Root folder)
   - Node.js application
   - Polls nextjs_alerttray for pending push tasks
   - Sends notifications to APNS
   - Reports results back to nextjs_alerttray
   - Communicates via secure internal APIs

3. **alerttray_ios** (Root folder)
   - Native iOS application (Swift/SwiftUI)
   - Receives push notifications from APNS
   - User authentication
   - Notification display and management

### Database Architecture

#### 1. User Write Model Databases (SQLite)
- **Creation**: One database per user account
- **Structure**: Single `events` table only
- **Location**: `nextjs_alerttray/data/users/{userId}/write.db`
- **Schema**:
```sql
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    event_data JSON NOT NULL,
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sequence_number INTEGER NOT NULL
);
CREATE INDEX idx_aggregate ON events(aggregate_id, aggregate_type);
CREATE INDEX idx_created_at ON events(created_at);
CREATE INDEX idx_sequence ON events(sequence_number);
```

#### 2. System Database (SQLite)
- **Location**: `nextjs_alerttray/data/system/system.db`
- **Purpose**: User sessions, authentication, API keys, device tokens
- **Schema**:
```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_session_token ON sessions(token_hash);
CREATE INDEX idx_session_expiry ON sessions(expires_at);

CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_api_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_key_user ON api_keys(user_id);

CREATE TABLE device_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL,
    device_name TEXT,
    platform TEXT DEFAULT 'ios',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX idx_device_token ON device_tokens(token);
CREATE INDEX idx_device_user ON device_tokens(user_id);
```

#### 3. Read Model Database (SQLite)
- **Location**: `nextjs_alerttray/data/read_model/read.db`
- **Purpose**: Projected state from all write models and task queue
- **Schema**:
```sql
CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    purpose_id TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT CHECK(severity IN ('low', 'medium', 'high', 'critical')),
    metadata JSON,
    status TEXT CHECK(status IN ('pending', 'delivered', 'failed', 'read')),
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
CREATE INDEX idx_notification_user ON notifications(user_id);
CREATE INDEX idx_notification_status ON notifications(status);
CREATE INDEX idx_notification_created ON notifications(created_at DESC);

CREATE TABLE push_tasks (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    device_token TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data JSON,
    status TEXT CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
CREATE INDEX idx_push_task_status ON push_tasks(status);
CREATE INDEX idx_push_task_notification ON push_tasks(notification_id);

CREATE TABLE notification_purposes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT,
    icon TEXT,
    active INTEGER DEFAULT 1,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
CREATE INDEX idx_purpose_user ON notification_purposes(user_id);
CREATE INDEX idx_purpose_active ON notification_purposes(active);

CREATE TABLE projection_checkpoints (
    user_id TEXT PRIMARY KEY,
    last_processed_sequence INTEGER NOT NULL,
    last_processed_at TIMESTAMP
);
```

## Detailed Component Specifications

### A. nextjs_alerttray Application

#### 1. Project Structure
```
nextjs_alerttray/
├── app/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login/route.ts
│   │   │   ├── logout/route.ts
│   │   │   └── register/route.ts
│   │   ├── notifications/
│   │   │   ├── push/route.ts           # Public API for pushing notifications
│   │   │   ├── list/route.ts           # Get notifications from read model
│   │   │   └── mark-read/route.ts
│   │   ├── purposes/
│   │   │   ├── create/route.ts
│   │   │   ├── list/route.ts
│   │   │   ├── toggle/route.ts
│   │   │   └── delete/route.ts
│   │   ├── api-keys/
│   │   │   ├── create/route.ts
│   │   │   ├── revoke/route.ts
│   │   │   └── list/route.ts
│   │   ├── devices/
│   │   │   └── register/route.ts
│   │   └── internal/
│   │       ├── tasks/route.ts          # Get pending push tasks
│   │       └── push-result/route.ts    # Report push results
│   ├── dashboard/
│   │   └── page.tsx
│   ├── purposes/
│   │   └── page.tsx
│   ├── api-keys/
│   │   └── page.tsx
│   ├── login/
│   │   └── page.tsx
│   ├── register/
│   │   └── page.tsx
│   ├── layout.tsx
│   └── page.tsx
├── lib/
│   ├── cqrs/
│   │   ├── command-bus.ts
│   │   ├── event-store.ts
│   │   ├── projection-engine.ts
│   │   └── query-bus.ts
│   ├── infrastructure/
│   │   ├── database/
│   │   │   └── connection.ts
│   │   └── security/
│   │       ├── auth.ts
│   │       └── api-security.ts
│   └── startup.ts
├── components/
│   ├── NotificationList.tsx
│   ├── ApiKeyManager.tsx
│   └── PurposeList.tsx
├── types/
│   └── index.ts
├── data/
├── package.json
├── tsconfig.json
└── next.config.ts
```

#### 2. Core CQRS Implementation

**Event Store Implementation** (`lib/cqrs/event-store.ts`):
```typescript
import { Event } from '@/types';
import { getUserWriteDatabase } from '@/lib/infrastructure/database/connection';

export function assert(condition: any, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export class EventStore {
  async appendEvents(userId: string, events: Event[]): Promise<void> {
    assert(userId, "User ID is required");
    assert(events.length > 0, "At least one event required");
    
    const db = getUserWriteDatabase(userId);
    
    const insert = db.prepare(`
      INSERT INTO events (
        aggregate_id, aggregate_type, event_type, 
        event_version, event_data, metadata, 
        created_at, sequence_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const getLastSequence = db.prepare(
      'SELECT MAX(sequence_number) as max_seq FROM events'
    );
    
    db.transaction(() => {
      const result = getLastSequence.get() as { max_seq: number | null };
      let nextSequence = (result.max_seq || 0) + 1;
      
      for (const event of events) {
        insert.run(
          event.aggregateId,
          event.aggregateType,
          event.eventType,
          event.eventVersion,
          JSON.stringify(event.eventData),
          event.metadata ? JSON.stringify(event.metadata) : null,
          event.createdAt.toISOString(),
          nextSequence++
        );
      }
    })();
    
    db.close();
  }
  
  async getEvents(
    userId: string, 
    fromSequence: number = 0,
    aggregateId?: string
  ): Promise<Event[]> {
    const db = getUserWriteDatabase(userId);
    
    let query = 'SELECT * FROM events WHERE sequence_number > ?';
    const params: any[] = [fromSequence];
    
    if (aggregateId) {
      query += ' AND aggregate_id = ?';
      params.push(aggregateId);
    }
    
    query += ' ORDER BY sequence_number ASC';
    
    const stmt = db.prepare(query);
    const rows = stmt.all(...params) as any[];
    
    db.close();
    
    return rows.map(row => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      eventType: row.event_type,
      eventVersion: row.event_version,
      eventData: JSON.parse(row.event_data),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: new Date(row.created_at),
      sequenceNumber: row.sequence_number
    }));
  }
}
```

**Command Bus** (`lib/cqrs/command-bus.ts`):
```typescript
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
}
```

**Projection Engine** (`lib/cqrs/projection-engine.ts`):
```typescript
import { Event } from '@/types';
import { EventStore } from './event-store';
import { getReadModelDatabase, getAllUserIds } from '@/lib/infrastructure/database/connection';

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
}
```

#### 3. Domain Events (Types)

```typescript
// types/index.ts

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

// Notification Events
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

// Purpose Events
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

// API Key Events
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
```

#### 4. API Endpoints Implementation

**Public Notification Push API** (`app/api/notifications/push/route.ts`):
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { getSystemDatabase } from '@/lib/infrastructure/database/connection';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { v4 as uuidv4 } from 'uuid';

export async function POST(request: NextRequest) {
  try {
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey) {
      return NextResponse.json({ error: 'API key required' }, { status: 401 });
    }
    
    // Validate API key
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    const db = getSystemDatabase();
    
    const keyRecord = db.prepare(`
      SELECT * FROM api_keys 
      WHERE key_hash = ? AND revoked_at IS NULL
    `).get(apiKeyHash) as any;
    
    if (!keyRecord) {
      db.close();
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }
    
    // Update last used
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), keyRecord.id);
    
    // Get device tokens for user
    const devices = db.prepare(`
      SELECT token FROM device_tokens WHERE user_id = ?
    `).all(keyRecord.user_id) as any[];
    
    db.close();
    
    if (devices.length === 0) {
      return NextResponse.json({ 
        error: 'No devices registered' 
      }, { status: 400 });
    }
    
    const body = await request.json();
    
    // Validate required fields
    if (!body.purposeId || !body.title || !body.message || !body.severity) {
      return NextResponse.json({ 
        error: 'Missing required fields' 
      }, { status: 400 });
    }
    
    const commandBus = new CommandBus();
    const notificationId = uuidv4();
    
    // Create notification and schedule push tasks
    await commandBus.dispatch({
      userId: keyRecord.user_id,
      aggregateId: notificationId,
      type: 'PushNotification',
      payload: {
        purposeId: body.purposeId,
        title: body.title,
        message: body.message,
        severity: body.severity,
        metadata: body.metadata,
        deviceTokens: devices.map(d => d.token)
      }
    });
    
    return NextResponse.json({ 
      success: true, 
      notificationId 
    });
  } catch (error) {
    console.error('Push notification error:', error);
    return NextResponse.json({ 
      error: 'Failed to push notification' 
    }, { status: 500 });
  }
}
```

**Internal Tasks API** (`app/api/internal/tasks/route.ts`):
```typescript
import { NextRequest } from 'next/server';
import { withInternalAuth, createInternalResponse } from '@/lib/infrastructure/security/api-security';
import { QueryBus } from '@/lib/cqrs/query-bus';

export async function GET(request: NextRequest) {
  return withInternalAuth(request, async () => {
    try {
      const queryBus = new QueryBus();
      const tasks = await queryBus.getPendingPushTasks();
      
      return createInternalResponse({ tasks });
    } catch (error) {
      console.error('Get tasks error:', error);
      return createInternalResponse({ 
        error: 'Failed to get tasks',
        tasks: []
      });
    }
  });
}
```

**Internal Push Result API** (`app/api/internal/push-result/route.ts`):
```typescript
import { NextRequest } from 'next/server';
import { withInternalAuth, createInternalResponse } from '@/lib/infrastructure/security/api-security';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { QueryBus } from '@/lib/cqrs/query-bus';

export async function POST(request: NextRequest) {
  return withInternalAuth(request, async (req) => {
    try {
      const body = await req.json();
      const { taskId, notificationId, success, errorMessage } = body;
      
      if (!taskId || !notificationId || typeof success !== 'boolean') {
        return createInternalResponse({
          error: 'Missing required fields'
        });
      }
      
      // Get task details from read model
      const queryBus = new QueryBus();
      const task = await queryBus.getPushTaskById(taskId);
      
      if (!task) {
        return createInternalResponse({ error: 'Task not found' });
      }
      
      const commandBus = new CommandBus();
      
      await commandBus.dispatch({
        userId: task.userId,
        aggregateId: notificationId,
        type: success ? 'CompletePushTask' : 'FailPushTask',
        payload: {
          taskId,
          notificationId,
          errorMessage
        }
      });
      
      return createInternalResponse({ success: true });
    } catch (error) {
      console.error('Push result error:', error);
      return createInternalResponse({
        error: 'Failed to update push result'
      });
    }
  });
}
```

### B. background_processor Application

#### 1. Project Structure
```
background_processor/
├── src/
│   ├── index.ts
│   ├── api-client.ts
│   ├── apns-client.ts
│   └── push-sender.ts
├── certificates/
│   └── AuthKey.p8         # APNS authentication key
├── package.json
├── tsconfig.json
└── .env
```

#### 2. Main Process Loop (`src/index.ts`)

```typescript
import * as dotenv from 'dotenv';
import { ApiClient } from './api-client';
import { PushSender } from './push-sender';

dotenv.config();

function assert(condition: any, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

class BackgroundProcessor {
  private checkInterval = 5000; // Check every 5 seconds
  private apiClient: ApiClient;
  private pushSender: PushSender;
  
  constructor() {
    this.apiClient = new ApiClient();
    this.pushSender = new PushSender();
  }
  
  async start(): Promise<void> {
    console.log('Background processor started');
    console.log(`API URL: ${process.env.ALERTTRAY_API_URL || 'http://localhost:3000'}`);
    console.log(`Check interval: ${this.checkInterval}ms`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    
    while (true) {
      try {
        await this.processPendingTasks();
      } catch (error) {
        console.error('Error in processing loop:', error);
      }
      
      await this.sleep(this.checkInterval);
    }
  }
  
  private async processPendingTasks(): Promise<void> {
    const tasks = await this.apiClient.getPendingTasks();
    
    if (tasks.length === 0) {
      return;
    }
    
    console.log(`Processing ${tasks.length} push tasks...`);
    
    const promises = tasks.map(task => this.processTask(task));
    const results = await Promise.allSettled(promises);
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    if (failed > 0) {
      console.log(`Completed ${successful} pushes, ${failed} failed`);
    }
  }
  
  private async processTask(task: any): Promise<void> {
    assert(task.id, "Task ID required");
    assert(task.device_token, "Device token required");
    assert(task.notification_id, "Notification ID required");
    
    try {
      await this.pushSender.sendNotification({
        deviceToken: task.device_token,
        title: task.title,
        message: task.message,
        data: JSON.parse(task.data || '{}')
      });
      
      console.log(`Push sent: ${task.notification_id} to ${task.device_token.substring(0, 8)}...`);
      
      await this.apiClient.reportPushResult({
        taskId: task.id,
        notificationId: task.notification_id,
        success: true
      });
    } catch (error: any) {
      console.error(`Push failed: ${task.notification_id}`, error.message);
      
      await this.apiClient.reportPushResult({
        taskId: task.id,
        notificationId: task.notification_id,
        success: false,
        errorMessage: error.message
      });
    }
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function main() {
  const processor = new BackgroundProcessor();
  
  process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\nShutting down gracefully...');
    process.exit(0);
  });
  
  try {
    await processor.start();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
```

#### 3. API Client (`src/api-client.ts`)

```typescript
import { createHmac } from 'crypto';
import fetch from 'node-fetch';

interface PushTask {
  id: string;
  notification_id: string;
  device_token: string;
  title: string;
  message: string;
  data: string;
}

interface PushResult {
  taskId: string;
  notificationId: string;
  success: boolean;
  errorMessage?: string;
}

function assert(condition: any, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  
  constructor() {
    this.baseUrl = process.env.ALERTTRAY_API_URL || 'http://localhost:3000';
    this.apiKey = process.env.API_KEY || '';
    
    assert(this.apiKey, "API_KEY environment variable is required");
  }
  
  private createSignature(body: string): string {
    return createHmac('sha256', this.apiKey)
      .update(body)
      .digest('hex');
  }
  
  async getPendingTasks(): Promise<PushTask[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/tasks`, {
        headers: {
          'X-API-Key': this.apiKey,
          'X-Signature': this.createSignature('')
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to get tasks: ${response.statusText}`);
      }
      
      const data = await response.json() as { tasks: PushTask[] };
      return data.tasks || [];
    } catch (error) {
      console.error('Error getting pending tasks:', error);
      return [];
    }
  }
  
  async reportPushResult(result: PushResult): Promise<void> {
    const body = JSON.stringify(result);
    
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/push-result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'X-Signature': this.createSignature(body)
        },
        body
      });
      
      if (!response.ok) {
        throw new Error(`Failed to report result: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error reporting push result:', error);
      throw error;
    }
  }
}
```

#### 4. APNS Client (`src/apns-client.ts`)

```typescript
import { sign } from 'jsonwebtoken';
import fetch from 'node-fetch';
import fs from 'fs';

export class ApnsClient {
  private teamId: string;
  private keyId: string;
  private privateKey: string;
  private bundleId: string;
  
  constructor() {
    this.teamId = process.env.APNS_TEAM_ID!;
    this.keyId = process.env.APNS_KEY_ID!;
    this.bundleId = process.env.APNS_BUNDLE_ID!;
    
    try {
      this.privateKey = fs.readFileSync('./certificates/AuthKey.p8', 'utf8');
    } catch (error) {
      console.error('Failed to read APNS private key:', error);
      throw new Error('APNS private key not found');
    }
    
    if (!this.teamId) throw new Error("APNS_TEAM_ID required");
    if (!this.keyId) throw new Error("APNS_KEY_ID required");
    if (!this.bundleId) throw new Error("APNS_BUNDLE_ID required");
  }
  
  private generateToken(): string {
    return sign(
      { iss: this.teamId },
      this.privateKey,
      {
        algorithm: 'ES256',
        keyid: this.keyId,
        expiresIn: '1h'
      }
    );
  }
  
  async sendNotification(
    deviceToken: string,
    payload: {
      title: string;
      message: string;
      badge?: number;
      sound?: string;
      data?: Record<string, any>;
    }
  ): Promise<void> {
    const token = this.generateToken();
    const environment = process.env.NODE_ENV === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    
    const apnsPayload = {
      aps: {
        alert: {
          title: payload.title,
          body: payload.message
        },
        badge: payload.badge || 1,
        sound: payload.sound || 'default',
        'content-available': 1
      },
      ...payload.data
    };
    
    const response = await fetch(
      `${environment}/3/device/${deviceToken}`,
      {
        method: 'POST',
        headers: {
          'authorization': `bearer ${token}`,
          'apns-topic': this.bundleId,
          'apns-priority': '10',
          'apns-push-type': 'alert'
        },
        body: JSON.stringify(apnsPayload)
      }
    );
    
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`APNS error: ${response.status} - ${body}`);
    }
  }
}
```

#### 5. Push Sender (`src/push-sender.ts`)

```typescript
import { ApnsClient } from './apns-client';

interface PushNotification {
  deviceToken: string;
  title: string;
  message: string;
  data?: Record<string, any>;
}

export class PushSender {
  private apnsClient: ApnsClient;
  
  constructor() {
    this.apnsClient = new ApnsClient();
  }
  
  async sendNotification(notification: PushNotification): Promise<void> {
    await this.apnsClient.sendNotification(
      notification.deviceToken,
      {
        title: notification.title,
        message: notification.message,
        data: notification.data
      }
    );
  }
}
```

### C. alerttray_ios Application

#### 1. Project Structure
```
alerttray_ios/
├── AlertTray/
│   ├── App/
│   │   ├── AlertTrayApp.swift
│   │   └── AppDelegate.swift
│   ├── Views/
│   │   ├── LoginView.swift
│   │   ├── DashboardView.swift
│   │   ├── NotificationListView.swift
│   │   └── SettingsView.swift
│   ├── Models/
│   │   ├── Notification.swift
│   │   ├── Purpose.swift
│   │   └── User.swift
│   ├── Services/
│   │   ├── APIService.swift
│   │   ├── AuthService.swift
│   │   ├── PushNotificationService.swift
│   │   └── KeychainService.swift
│   ├── ViewModels/
│   │   ├── LoginViewModel.swift
│   │   └── NotificationViewModel.swift
│   └── Info.plist
├── AlertTray.xcodeproj
└── Podfile
```

#### 2. Push Notification Service Implementation

```swift
// Services/PushNotificationService.swift
import UserNotifications
import UIKit

class PushNotificationService: NSObject {
    static let shared = PushNotificationService()
    
    private override init() {
        super.init()
    }
    
    func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, error in
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }
    
    func handleRegistration(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        
        // Send token to backend
        Task {
            try await APIService.shared.registerDevice(token: token)
        }
    }
    
    func handleNotification(_ userInfo: [AnyHashable: Any]) {
        guard let aps = userInfo["aps"] as? [String: Any],
              let alert = aps["alert"] as? [String: Any],
              let title = alert["title"] as? String,
              let body = alert["body"] as? String else {
            return
        }
        
        // Extract custom data
        let notificationId = userInfo["notificationId"] as? String
        
        // Update local storage and UI
        NotificationStore.shared.addNotification(
            Notification(
                id: notificationId ?? UUID().uuidString,
                title: title,
                message: body,
                receivedAt: Date()
            )
        )
    }
}
```

## Event Flow Examples

### Complete Notification Push Flow

1. **External system calls API** (`POST /api/notifications/push`)
   - Includes API key in `X-API-Key` header
   - Body contains purposeId, title, message, severity

2. **Next.js validates and processes**
   - Validates API key against system database
   - Gets user's registered device tokens
   - Command bus creates events:
     - `NotificationPushedEvent` - Notification received
     - `PushTaskScheduledEvent` (one per device) - Tasks for background processor

3. **Events written to user's write model**
   - Stored in `data/users/{userId}/write.db`
   - Sequence numbers incremented

4. **Projection engine updates read model** (1-second interval)
   - Creates notification record (status: 'pending')
   - Creates push_task records (status: 'pending')

5. **Background processor polls for tasks** (5-second interval)
   - Calls `/api/internal/tasks`
   - Gets pending push tasks from read model

6. **Background processor sends to APNS**
   - Uses JWT authentication with Apple
   - Sends notification payload

7. **Background processor reports result**
   - Calls `/api/internal/push-result`
   - Success or failure with error message

8. **Next.js processes result**
   - Writes `PushTaskCompletedEvent` or `PushTaskFailedEvent`
   - Updates read model task status

9. **iOS app receives notification**
   - APNS delivers to device
   - App displays notification

10. **Dashboard reflects status** (1-second polling)
    - Shows delivery status
    - Updates unread count

### API Key Management Flow

1. User requests new API key
2. System revokes existing active key (if any)
3. System generates `atk_` prefixed key
4. System writes `ApiKeyCreatedEvent`
5. System stores key hash in system database
6. Key returned to user (only time shown)
7. Projection engine updates read model

### Purpose Toggle Flow

1. User toggles purpose active/inactive
2. System writes `NotificationPurposeDeactivatedEvent`
3. Projection engine updates read model
4. Future notifications check purpose status
5. Inactive purposes don't create push tasks

## Security Considerations

### API Key Security
- SHA-256 hashing for storage
- Keys shown only once at creation
- Format: `atk_{32_random_hex_chars}`
- One active key per user
- Rate limiting per key

### Internal API Security
- HMAC signatures on all internal calls
- Shared secret via environment variables
- Request body integrity verification

### Data Isolation
- Each user has separate write model database
- Read model queries filtered by user_id
- API keys scoped to single user

## Environment Variables

### nextjs_alerttray/.env.local
```env
DATABASE_PATH=./data
SESSION_SECRET=<random-32-char-string>
BACKGROUND_PROCESSOR_API_KEY=<random-32-char-string>
```

### background_processor/.env
```env
ALERTTRAY_API_URL=http://localhost:3000
API_KEY=<same-as-BACKGROUND_PROCESSOR_API_KEY>
APNS_TEAM_ID=<apple-team-id>
APNS_KEY_ID=<apple-key-id>
APNS_BUNDLE_ID=com.example.alerttray
NODE_ENV=development
```

## Dependencies

### nextjs_alerttray/package.json
```json
{
  "name": "nextjs_alerttray",
  "version": "1.0.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "better-sqlite3": "^12.0.0",
    "bcrypt": "^6.0.0",
    "uuid": "^12.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/react": "^19.0.0",
    "@types/bcrypt": "^6.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "typescript": "^5.0.0",
    "@tailwindcss/postcss": "^4.0.0",
    "tailwindcss": "^4.0.0"
  }
}
```

### background_processor/package.json
```json
{
  "name": "background_processor",
  "version": "1.0.0",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "node-fetch": "^3.3.0",
    "dotenv": "^17.0.0",
    "jsonwebtoken": "^9.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/jsonwebtoken": "^9.0.0",
    "typescript": "^5.0.0",
    "tsx": "^4.0.0"
  }
}
```

## Implementation Priorities (MVP)

### Phase 1: Core Infrastructure (Week 1)
1. Set up Next.js project with TypeScript
2. Implement SQLite database layer (copy from StatusNest)
3. Create CQRS event store with assertions
4. Implement user authentication
5. Set up system database schema

### Phase 2: Notification System (Week 2)
1. API key generation and management
2. Notification push API endpoint
3. Purpose creation and management
4. Event generation for notifications
5. Projection engine (1-second interval)

### Phase 3: Background Processing (Week 3)
1. Set up background_processor
2. Implement secure API client
3. APNS client with JWT authentication
4. Task polling and processing
5. Result reporting

### Phase 4: iOS Application (Week 4-5)
1. Set up Xcode project
2. Implement authentication flow
3. Push notification registration
4. Notification display UI
5. APNS certificate setup

### Phase 5: Integration & Testing (Week 6)
1. End-to-end notification flow
2. Real-time dashboard updates
3. Push notification delivery testing
4. Error handling and logging
5. Production deployment prep

## Testing Strategy

### Test Scripts
```javascript
// test-auth.js - Test authentication flow
// test-api-key.js - Test API key creation and usage
// test-push.js - Test notification push flow
// test-background.js - Test background processor
```

### Manual Testing
1. Register user account
2. Create API key
3. Register iOS device
4. Create notification purpose
5. Push test notification
6. Verify delivery to device
7. Mark notification as read
8. Toggle purpose active/inactive

## Development Commands

### Starting the System
```bash
# Terminal 1: Next.js application
cd nextjs_alerttray
npm install
npm run dev

# Terminal 2: Background processor
cd background_processor
npm install
npm run dev

# Terminal 3: iOS app (in Xcode)
open alerttray_ios/AlertTray.xcodeproj
# Build and run in simulator
```

## Monitoring & Logging

### Application Logs
- Event processing
- API requests (with API key usage)
- Push notification delivery status
- Projection processing metrics

### Metrics to Track
- Notifications per user
- API key usage patterns
- Push delivery success rate
- Projection lag
- Task processing time

## Error Handling

### Pre-condition Assertions
```typescript
function assert(condition: any, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
```

### Graceful Degradation
- Queue failed push notifications for retry
- Continue processing other tasks if one fails
- Log errors without crashing
- Exponential backoff for failed deliveries

## Performance Considerations

### Database Optimization
- Indexes on frequently queried fields
- Connection pooling for SQLite
- Batch event processing
- Efficient projection queries

### Push Notification Optimization
- Batch processing where possible
- Connection reuse for APNS
- Async task processing
- Rate limiting compliance

### Polling Optimization
- Frontend: 1-second intervals
- Background processor: 5-second intervals
- Projection engine: 1-second intervals

## Future Enhancements (Post-MVP)

1. Android app support (FCM integration)
2. Web push notifications
3. Email notification channel
4. SMS notification channel
5. Webhook integrations
6. Notification templates
7. Scheduled notifications
8. Rich media notifications
9. Notification grouping/threading
10. Custom notification sounds
11. Do Not Disturb scheduling
12. Analytics dashboard
13. Multi-tenant support
14. Notification history export
15. Rate limiting per purpose