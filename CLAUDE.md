# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AlertTray is a notification management service built with CQRS (Command Query Responsibility Segregation) and Event Sourcing patterns. The system consists of three main components:

1. **nextjs_alerttray** - Next.js application with integrated backend, CQRS implementation, and secure API endpoints
2. **background_processor** - Node.js application that polls for pending push tasks and sends notifications via APNS
3. **alerttray_ios** - Native iOS application that receives push notifications

## Architecture

- **CQRS Pattern**: Commands write events to user-specific SQLite databases, projections update read models
- **Event Sourcing**: All state changes are stored as events in write model databases
- **Database Structure**:
  - User Write Model: `nextjs_alerttray/data/users/{userId}/write.db` (events only)
  - System Database: `nextjs_alerttray/data/system/system.db` (users, sessions, API keys, device tokens)
  - Read Model: `nextjs_alerttray/data/read_model/read.db` (projected state, task queue)

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
```

### Build Commands
```bash
# Next.js build
cd nextjs_alerttray
npm run build

# Background processor build
cd background_processor
npm run build
```

## Key Implementation Details

### Event Store Pattern
- Uses assertion functions for pre-condition checks: `assert(condition, "message")`
- Events have sequence numbers for ordering
- Projection engine runs on 1-second intervals
- Each user has a separate write model database

### API Security
- Public API uses API keys with format: `atk_{32_random_hex_chars}`
- Internal APIs use HMAC signatures for authentication
- API keys are SHA-256 hashed before storage
- One active API key per user (auto-revokes previous)

### Push Notification Flow
1. External system calls `/api/notifications/push` with API key
2. Command bus creates `NotificationPushedEvent` and `PushTaskScheduledEvent`
3. Projection engine updates read model with pending tasks
4. Background processor polls `/api/internal/tasks` every 5 seconds
5. Sends to APNS and reports results via `/api/internal/push-result`

### Polling Intervals
- Frontend dashboard: 1-second polling
- Projection engine: 1-second intervals
- Background processor: 5-second intervals

## Critical Files and Locations

### Core CQRS Implementation
- `nextjs_alerttray/lib/cqrs/event-store.ts` - Event storage and retrieval
- `nextjs_alerttray/lib/cqrs/command-bus.ts` - Command handling and event generation
- `nextjs_alerttray/lib/cqrs/projection-engine.ts` - Event projection to read model
- `nextjs_alerttray/lib/cqrs/query-bus.ts` - Query handling from read model

### API Endpoints
- `nextjs_alerttray/app/api/notifications/push/route.ts` - Public notification API
- `nextjs_alerttray/app/api/internal/tasks/route.ts` - Internal task polling API
- `nextjs_alerttray/app/api/internal/push-result/route.ts` - Push result reporting

### Background Processor
- `background_processor/src/index.ts` - Main process loop
- `background_processor/src/api-client.ts` - Internal API communication
- `background_processor/src/apns-client.ts` - Apple Push Notification Service client

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

## Testing Approach
- Test authentication flow with user registration/login
- Test API key creation and usage
- Test notification push flow end-to-end
- Verify projection engine updates
- Test background processor task polling
- Verify APNS delivery (requires certificates)