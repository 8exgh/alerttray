# AlertTray - Notification Management System

AlertTray is a notification management service built with CQRS (Command Query Responsibility Segregation) and Event Sourcing patterns. It allows users to push notifications through a secure API and delivers them by severity: always as an iOS push (APNS), plus a **phone call and SMS** for `high`/`critical` (via the 8Examples phone-call-gateway) or an **email** for `medium`/`low`.

## System Components

1. **nextjs_alerttray** - Next.js web application with CQRS backend
2. **background_processor** - Node.js service that delivers queued notifications over APNS, phone call, SMS and email
3. **alerttray_ios** - Native iOS application for receiving notifications

## Quick Start

### Prerequisites
- Node.js 20+ and npm
- Xcode (for iOS app)
- Apple Developer account (for APNS)

### 1. Start the Next.js Application

```bash
cd nextjs_alerttray
npm install
npm run dev
```

The web application will be available at http://localhost:3000

### 2. Start the Background Processor

```bash
cd background_processor
npm install

# Configure environment variables
cp .env .env.local
# Edit .env.local with your APNS credentials

npm run dev
```

### 3. Run the iOS App

1. Open `alerttray_ios/AlertTray.xcodeproj` in Xcode
2. Configure your development team and bundle identifier
3. Build and run on simulator or device

## Initial Setup

### 1. Create an Account
- Navigate to http://localhost:3000/register
- Create a new account with email and password

### 2. Generate an API Key
- After logging in, go to the Dashboard
- Click "Create API Key"
- Save the generated key securely (it won't be shown again)

### 3. Set your phone number
- Go to **Delivery Settings** (`/settings`) and enter your phone number in international format (e.g. `+14155552671`)
- High and critical alerts call and text this number; without it they fall back to email
- Optionally set a separate alert email (defaults to your account email)

### 4. Configure APNS (for production)
- Obtain an APNS authentication key from Apple Developer Portal
- Place the `.p8` file in `background_processor/certificates/AuthKey.p8`
- Update `background_processor/.env` with your Apple credentials:
  ```
  APNS_TEAM_ID=YOUR_TEAM_ID
  APNS_KEY_ID=YOUR_KEY_ID
  APNS_BUNDLE_ID=com.yourcompany.alerttray
  ```

## API Usage

### Pushing a Notification

```bash
curl -X POST http://localhost:3000/api/notifications/push \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "purposeId": "general",
    "title": "Test Notification",
    "message": "This is a test message",
    "severity": "medium",
    "metadata": {}
  }'
```

### API Fields
- `purposeId` - Category/purpose of the notification
- `title` - Notification title
- `message` - Notification body
- `severity` - One of: low, medium, high, critical
- `metadata` - Optional additional data

Response: `{ "success": true, "notificationId": "...", "channels": ["call","sms"], "skippedChannels": [] }` — `skippedChannels` lists channels the policy wanted but the user has no recipient for (e.g. no phone number).

### Alerting someone other than the account holder

An integration that alerts on behalf of *its* users (StatusNest calling a site's owner, for example) can pass
the person to reach in the request. When `recipients` is present it **replaces** the account holder's phone
number and alert email for that notification — a missing or blank field means that channel has no recipient
(it does not fall back to the account holder). Registered iPhones still receive the push.

```bash
curl -X POST http://localhost:3000/api/notifications/push \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "purposeId": "statusnest-domain-offline",
    "title": "example.com is offline",
    "message": "StatusNest could not reach example.com. The server responded with HTTP 503.",
    "severity": "critical",
    "recipients": { "phoneNumber": "+14155552671", "email": "owner@example.com" }
  }'
```

### Delivery by severity

| Severity | Channels |
|----------|----------|
| critical | iPhone push, phone call, SMS *(iPhone emergency alert: in progress)* |
| high     | iPhone push, phone call, SMS |
| medium   | iPhone push, email |
| low      | iPhone push, email |

The mapping lives in `nextjs_alerttray/lib/delivery/routing-policy.ts`. Calls and SMS go through the
[phone-call-gateway](https://phone-gateway.fusenv.com) (Twilio behind it); a call is an LLM voice agent that
reads the alert out loud, confirms it was heard and hangs up. Email goes out over Gmail SMTP.

In production, alerts come from AlertTray's own gateway client (`alerttray`) and number **+1 587-809-5774** —
save it as a contact so critical calls can bypass Do Not Disturb / Focus. The client's `pgw_` key lives in
the devops repo secret `ALERTTRAY_PHONE_GATEWAY_API_KEY` and can be re-read with the gateway admin key via
`GET /clients`.

### Email delivery failure checks (operators)

The background processor checks the sending mailbox for permanent delivery failure notices every minute.
For Gmail SMTP, it reuses `GMAIL_USER` / `GMAIL_APP_PASSWORD` (or `SMTP_USER` / `SMTP_PASS`) over TLS IMAP.
It opens Gmail's All Mail folder when available, otherwise INBOX, in **read-only** mode; it does not mark,
move or delete messages. `DELIVERY_DRY_RUN=1` also disables mailbox access.

Structured [RFC 3464 bounce reports](https://www.rfc-editor.org/rfc/rfc3464) are matched by the original SMTP Message-ID **and** recipient through the
authenticated `/api/internal/email-bounces` endpoint. A confirmed bounce marks the email task failed
and stores the SMTP diagnostic. A notification fails when all its delivery channels failed; successful
push/SMS/call deliveries and the user's read state are preserved. Reports are idempotent, and late SMTP
success reports cannot undo a recorded bounce.

Confirmed permanent recipient failures automatically add the address to the private `email_suppressions`
table in the system database. This covers missing/invalid destinations (`5.1.1`, `5.1.2`, `5.1.3`), moved
mailboxes without forwarding (`5.1.6`), null MX destinations (`5.1.10`) and permanently disabled mailboxes
(`5.2.1`), following the [enhanced status code registry](https://www.iana.org/assignments/smtp-enhanced-status-codes/).
Immediate SMTP `RCPT TO` rejections with these enhanced codes also suppress the recipient. Full mailboxes,
temporary failures, sender errors, generic `550` responses and content/policy failures do not automatically
block future messages. They can still be blocked explicitly using the worker's operator-managed list.

Every real email send checks the shared list through the authenticated
`POST /api/internal/email-suppressions/check` endpoint before contacting SMTP, including already queued
tasks. Blocks have no automatic expiry, survive restarts and apply across accounts and workers. The check
returns only a boolean; no list or reason is exposed to clients. A failed check prevents SMTP delivery and
fails the task. Messages already in flight when a block is recorded cannot be recalled.

The first check scans the last 30 days. Existing SMTP IDs are recovered from completion events during
the database migration. Previously recorded qualifying bounce/SMTP failures also populate the suppression
table on its first creation, even when the mailbox cursor has passed those notices.
Subsequent checks resume from `data/email-bounce-checkpoint.json`; keep the
worker's data volume mounted. API/mailbox failures are retried without advancing past the failed report.
Deploy the Next.js backend **before** the worker to activate this feature; mailbox authentication still needs to
be verified in the deployed environment.

Optional worker settings:

```env
# EMAIL_BOUNCE_MONITOR=0                 # disable monitoring
# EMAIL_BOUNCE_IMAP_HOST=imap.example.com # required for custom SMTP providers
# EMAIL_BOUNCE_IMAP_PORT=993             # TLS only
# EMAIL_BOUNCE_IMAP_USER=bounces@example.com
# EMAIL_BOUNCE_IMAP_PASSWORD=<mailbox-password>
# EMAIL_BOUNCE_MAILBOX=INBOX             # override All Mail / INBOX selection
# EMAIL_BOUNCE_RETURN_PATH=bounces@example.com
# EMAIL_BOUNCE_CHECKPOINT_PATH=/app/data/email-bounce-checkpoint.json
```

Gmail sends use the authenticated account as the SMTP return path, even when `EMAIL_FROM` is an alias.
For custom SMTP, configure the return path and monitored mailbox together. Messages accepted by SMTP
remain provisionally delivered unless a matching permanent bounce arrives. Temporary delay notices,
unstructured bounce emails, missing original message IDs, silently dropped mail and notices outside the
selected folder cannot establish failure here. Reports over 2 MiB are skipped with a worker warning.
An unmatched recent report is retried for ten minutes to allow completion events to project; older
unmatched notices are ignored because the mailbox may be shared with other applications.

Operators can inspect confirmed bounces directly in the read database:

```sql
SELECT recipient, error_message, bounced_at
FROM delivery_tasks
WHERE channel = 'email' AND bounced_at IS NOT NULL
ORDER BY bounced_at DESC;
```

To inspect automatic blocks, query the **system** database (`data/system/system.db`):

```sql
SELECT recipient, status, diagnostic, source_task_id, created_at
FROM email_suppressions ORDER BY created_at DESC;
```

An operator can remove a corrected address from that table to allow future sends. A new qualifying failure
will block it again. The explicit worker list and `EMAIL_SUPPRESSION_LIST` are independent and still apply.

### Contact details API
```bash
# Read (session cookie or Bearer token)
curl http://localhost:3000/api/contact -b cookies.txt
# Update
curl -X PUT http://localhost:3000/api/contact -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+14155552671", "notificationEmail": "alerts@example.com"}'
```

## Architecture

### CQRS & Event Sourcing
- All state changes are captured as events
- Each user has a separate write model database
- Projections update read models for queries
- 1-second polling for real-time updates

### Database Structure
- **Write Model**: `data/users/{userId}/write.db` - Event store
- **System DB**: `data/system/system.db` - Users (incl. phone number / alert email), sessions, API keys, device tokens
- **Read Model**: `data/read_model/read.db` - Projected state and the `delivery_tasks` queue (one row per channel × recipient)

### Security
- API keys use SHA-256 hashing
- Session-based authentication for web UI
- HMAC signatures for internal APIs
- Each user's data is isolated

## Development

### Running Tests
```bash
# In nextjs_alerttray directory
npm test

# In background_processor directory
npm test
```

### Building for Production
```bash
# Next.js app
cd nextjs_alerttray
npm run build
npm start

# Background processor
cd background_processor
npm run build
npm start
```

## Troubleshooting

### Notifications not being delivered
1. Check background processor is running
2. Verify APNS credentials are configured
3. Ensure device tokens are registered
4. Check projection engine is processing events
5. For calls/SMS: `PHONE_GATEWAY_API_KEY` must be a valid gateway client key and the user needs a phone number in Delivery Settings (the push response shows `skippedChannels`)
6. For email: `GMAIL_USER` / `GMAIL_APP_PASSWORD` must be set on the background processor
7. Set `DELIVERY_DRY_RUN=1` on the background processor to see what *would* be sent without sending

### Database issues
- Delete `data/` directory to reset all databases
- Check file permissions on data directories

### Connection errors
- Ensure all services are running
- Check environment variables are set correctly
- Verify internal API key matches between services

## Environment Variables

### nextjs_alerttray/.env.local
```
DATABASE_PATH=./data
SESSION_SECRET=<random-32-char-string>
BACKGROUND_PROCESSOR_API_KEY=<shared-secret>
```

### background_processor/.env
```
ALERTTRAY_API_URL=http://localhost:3000
API_KEY=<same-as-BACKGROUND_PROCESSOR_API_KEY>
APNS_TEAM_ID=<apple-team-id>
APNS_KEY_ID=<apple-key-id>
APNS_BUNDLE_ID=com.example.alerttray
NODE_ENV=development

# Phone call + SMS via phone-call-gateway (client key minted by the gateway admin)
PHONE_GATEWAY_URL=https://phone-gateway.fusenv.com
PHONE_GATEWAY_API_KEY=pgw_...
# PHONE_GATEWAY_VOICE=alloy
# PHONE_GATEWAY_CALL_WAIT_MS=180000

# Email via Gmail SMTP
GMAIL_USER=<gmail-address>
GMAIL_APP_PASSWORD=<gmail-app-password>
# EMAIL_FROM="AlertTray <alerts@example.com>"

# Local development: log instead of sending
# DELIVERY_DRY_RUN=1
```

## License

MIT
