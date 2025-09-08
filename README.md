# AlertTray - Notification Management System

AlertTray is a notification management service built with CQRS (Command Query Responsibility Segregation) and Event Sourcing patterns. It allows users to push notifications through a secure API to iOS devices via Apple Push Notification Service (APNS).

## System Components

1. **nextjs_alerttray** - Next.js web application with CQRS backend
2. **background_processor** - Node.js service for processing push notifications
3. **alerttray_ios** - Native iOS application for receiving notifications

## Quick Start

### Prerequisites
- Node.js 18+ and npm
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

### 3. Configure APNS (for production)
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

## Architecture

### CQRS & Event Sourcing
- All state changes are captured as events
- Each user has a separate write model database
- Projections update read models for queries
- 1-second polling for real-time updates

### Database Structure
- **Write Model**: `data/users/{userId}/write.db` - Event store
- **System DB**: `data/system/system.db` - Users, sessions, API keys
- **Read Model**: `data/read_model/read.db` - Projected state

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
```

## License

MIT