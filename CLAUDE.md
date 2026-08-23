# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AlertTray is a notification management service built with CQRS (Command Query Responsibility Segregation) and Event Sourcing patterns. The system consists of three main components:

1. **nextjs_alerttray** - Next.js application with integrated backend, CQRS implementation, and secure API endpoints
2. **background_processor** - Node.js application that polls for pending delivery tasks and sends them via APNS (push), the phone-call-gateway (voice call, SMS) and SMTP (email)
3. **alerttray_ios** - Native iOS application that receives push notifications

## Architecture

- **CQRS Pattern**: Commands write events to user-specific SQLite databases, projections update read models
- **Event Sourcing**: All state changes are stored as events in write model databases
- **Database Structure**:
  - User Write Model: `nextjs_alerttray/data/users/{userId}/write.db` (events only)
  - System Database: `nextjs_alerttray/data/system/system.db` (users incl. contact details, sessions, API keys, device tokens)
  - Read Model: `nextjs_alerttray/data/read_model/read.db` (projected state, `delivery_tasks` queue)
- **Multi-channel delivery**: every notification fans out into one `delivery_tasks` row per (channel, recipient). Channels are `apns`, `call`, `sms`, `email` (and `emergency`, reserved for iPhone emergency alerts — iOS side in progress).

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

### Severity → Channel Routing
Defined in one place: `nextjs_alerttray/lib/delivery/routing-policy.ts` (`SEVERITY_CHANNEL_POLICY`).
- `critical`, `high` → APNS push + **phone call + SMS** (via phone-call-gateway). `critical` will additionally use iPhone emergency alerts once the iOS side lands (`emergency` channel, not routed yet).
- `medium`, `low` → APNS push + **email**.
- If a routed channel has no recipient configured (e.g. no phone number), it is skipped and `FALLBACK_CHANNEL` (`email`) is used instead. The push API response reports `channels` and `skippedChannels`.
- Users set their phone number / alert email on `/settings` (`GET|PUT /api/contact`). Phone numbers are stored in E.164.
- A push request may carry `recipients: { phoneNumber?, email? }` (validated by `parseRecipientOverrides`). When present it replaces the account holder's phone/email for that notification only — blank means "no recipient for that channel", never a fallback to the account holder. Device tokens are unaffected. Used by integrations that alert on behalf of their own users (StatusNest → site owner).

### Notification Delivery Flow
1. External system calls `/api/notifications/push` with API key
2. Route resolves delivery targets from severity + the user's contact details/devices (`resolveDeliveryTargets`)
3. Command bus creates `NotificationPushedEvent` and one `DeliveryTaskScheduledEvent` per target
4. Projection engine writes `notifications` + `delivery_tasks` rows into the read model
5. Background processor polls `/api/internal/tasks` every 5 seconds (tasks are atomically moved to `processing`)
6. `DeliveryDispatcher` sends on the task's channel (APNS / gateway `/orchestrations` / gateway `/sms` / SMTP) and reports via `/api/internal/push-result` → `DeliveryTaskCompletedEvent` / `DeliveryTaskFailedEvent`
7. A notification is `delivered` when no tasks are pending/processing, `failed` only when every task failed
8. Tasks left in `processing` for 15 minutes without a result (processor crashed, or an out-of-date processor claimed them) are re-queued on the next poll by `QueryBus.reclaimStaleTasks`; after 3 attempts they are failed via `FailDeliveryTask`

Legacy `PushTask*` events are still projected (as `channel: 'apns'`); an existing `push_tasks` table is migrated into `delivery_tasks` on first open and renamed `push_tasks_legacy`.

### External Services
- **phone-call-gateway** (`~/8Examples/phone-call-gateway`, live at `https://phone-gateway.fusenv.com`): Twilio-backed. Bearer auth with a per-client `pgw_…` key minted via the gateway admin (`POST /clients`). AlertTray's client is `alerttray` (number `+15878095774`); its key is the devops secret `ALERTTRAY_PHONE_GATEWAY_API_KEY`. SMS = `POST /sms {to, body}`. Calls = `POST /orchestrations {to, goal, openingLine, tools: []}` — an LLM voice agent reads the alert; we poll `GET /orchestrations/:id` until it ends. No idempotency key on the gateway, so never retry a task blindly.
- **Email**: nodemailer over Gmail SMTP (465) with `GMAIL_USER` / `GMAIL_APP_PASSWORD`, same as the other 8Examples services.
- Set `DELIVERY_DRY_RUN=1` on the background processor to log instead of sending on every channel.

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

### Delivery Routing
- `nextjs_alerttray/lib/delivery/routing-policy.ts` - Severity → channel policy, fallback, target resolution, phone/email validation
- `nextjs_alerttray/lib/infrastructure/users/contact-details.ts` - Phone number / alert email storage

### API Endpoints
- `nextjs_alerttray/app/api/notifications/push/route.ts` - Public notification API
- `nextjs_alerttray/app/api/contact/route.ts` - Current user's contact details (session auth)
- `nextjs_alerttray/app/api/internal/tasks/route.ts` - Internal task polling API
- `nextjs_alerttray/app/api/internal/push-result/route.ts` - Delivery result reporting (all channels)

### Background Processor
- `background_processor/src/index.ts` - Main process loop
- `background_processor/src/api-client.ts` - Internal API communication
- `background_processor/src/delivery-dispatcher.ts` - Picks the sender for a task's channel; `DELIVERY_DRY_RUN` support
- `background_processor/src/apns-client.ts` - Apple Push Notification Service client
- `background_processor/src/phone-gateway-client.ts` - phone-call-gateway client (SMS + voice call)
- `background_processor/src/email-client.ts` - SMTP (Gmail) client
- `background_processor/src/message-format.ts` - Per-channel wording (SMS text, call script, email subject/body)

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

# Phone call + SMS (high/critical) via phone-call-gateway
PHONE_GATEWAY_URL=https://phone-gateway.fusenv.com
PHONE_GATEWAY_API_KEY=pgw_<client-key-minted-by-gateway-admin>
# PHONE_GATEWAY_VOICE=alloy            # optional TTS voice
# PHONE_GATEWAY_CALL_WAIT_MS=180000    # how long to wait for a call to finish

# Email (medium/low, and fallback) via Gmail SMTP
GMAIL_USER=<gmail-address>
GMAIL_APP_PASSWORD=<gmail-app-password>
# EMAIL_FROM="AlertTray <alerts@example.com>"   # defaults to AlertTray <GMAIL_USER>
# SMTP_HOST=smtp.gmail.com / SMTP_PORT=465      # override for a non-Gmail relay

# Log instead of sending on every channel (local dev)
# DELIVERY_DRY_RUN=1
```

Production values are injected by the devops repo workflow
(`devops/.github/workflows/deploy-alerttray_background_processor.yml`) as `-e` flags:
`PHONE_GATEWAY_URL`, `PHONE_GATEWAY_API_KEY` (secret `ALERTTRAY_PHONE_GATEWAY_API_KEY`),
`GMAIL_USER` / `GMAIL_APP_PASSWORD` (shared secrets `GMAIL_8EXAMPLES_*`).

## Testing Approach
- Test authentication flow with user registration/login
- Test API key creation and usage
- Set a phone number via `PUT /api/contact` and push `high`/`critical` → expect `call` + `sms` tasks; push `medium`/`low` → expect `email`
- Push `high` with no phone number → expect `skippedChannels: ["call","sms"]` and an `email` fallback task
- Verify projection engine updates (`delivery_tasks` rows)
- Run the background processor with `DELIVERY_DRY_RUN=1` to exercise polling + result reporting without sending
- Verify APNS delivery (requires certificates), gateway calls/SMS (requires `PHONE_GATEWAY_API_KEY`), email (requires Gmail credentials)