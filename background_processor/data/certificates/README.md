# APNS Certificate

Place your Apple Push Notification Service authentication key file here as `AuthKey.p8`.

To obtain this key:
1. Go to Apple Developer Portal
2. Navigate to Keys section
3. Create a new key with Apple Push Notifications service (APNs) enabled
4. Download the .p8 file
5. Rename it to `AuthKey.p8` and place it in this directory

Make sure to update the `.env` file with:
- `APNS_TEAM_ID`: Your Apple Developer Team ID
- `APNS_KEY_ID`: The Key ID from the downloaded certificate
- `APNS_BUNDLE_ID`: Your iOS app's bundle identifier