import { NextRequest, NextResponse } from 'next/server';
import { ApiSecurity } from '@/lib/infrastructure/security/api-security';
import { ContactDetailsService } from '@/lib/infrastructure/users/contact-details';
import { isSeverity, parseRecipientOverrides, resolveDeliveryTargets, SEVERITY_LEVELS } from '@/lib/delivery/routing-policy';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { v4 as uuidv4 } from 'uuid';
import { initializeSystem } from '@/lib/startup';

export async function POST(request: NextRequest) {
  await initializeSystem();
  
  try {
    const apiKey = request.headers.get('X-API-Key');
    
    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key required' },
        { status: 401 }
      );
    }
    
    // Validate API key
    const keyData = await ApiSecurity.validateApiKey(apiKey);
    
    if (!keyData) {
      return NextResponse.json(
        { error: 'Invalid API key' },
        { status: 401 }
      );
    }
    
    const body = await request.json();
    
    // Validate required fields
    if (!body.purposeId || !body.title || !body.message || !body.severity) {
      return NextResponse.json(
        { error: 'Missing required fields: purposeId, title, message, severity' },
        { status: 400 }
      );
    }
    
    // Validate severity
    if (!isSeverity(body.severity)) {
      return NextResponse.json(
        { error: `Invalid severity. Must be: ${SEVERITY_LEVELS.join(', ')}` },
        { status: 400 }
      );
    }
    
    // Route by severity: apns to every registered device, plus call/sms for
    // high & critical and email for medium & low (see lib/delivery/routing-policy.ts)
    let contact = ContactDetailsService.getDeliveryContact(keyData.userId);
    
    // Optional per-notification recipients: an integration alerting on behalf
    // of its own user (e.g. StatusNest calling a site owner) passes who to
    // reach, and the account holder's phone/email are not used for this one.
    if (body.recipients !== undefined) {
      const overrides = parseRecipientOverrides(body.recipients);
      if ('error' in overrides) {
        return NextResponse.json({ error: overrides.error }, { status: 400 });
      }
      contact = {
        ...contact,
        phoneNumber: overrides.phoneNumber,
        notificationEmail: overrides.notificationEmail
      };
    }
    
    const { targets, skipped } = resolveDeliveryTargets(body.severity, contact);
    
    if (skipped.length > 0) {
      console.warn(
        `⚠️  ${body.severity} notification for user ${keyData.userId}: ` +
        `no recipient configured for channel(s) ${skipped.join(', ')}` +
        (body.recipients !== undefined ? ' (request-supplied recipients)' : ' — set a phone number in Settings')
      );
    }
    
    const commandBus = new CommandBus();
    const notificationId = uuidv4();
    
    // Create notification and schedule a delivery task per channel/recipient
    await commandBus.dispatch({
      userId: keyData.userId,
      aggregateId: notificationId,
      type: 'PushNotification',
      payload: {
        purposeId: body.purposeId,
        title: body.title,
        message: body.message,
        severity: body.severity,
        metadata: body.metadata,
        deliveries: targets
      }
    });
    
    return NextResponse.json({
      success: true,
      notificationId,
      channels: Array.from(new Set(targets.map(t => t.channel))),
      skippedChannels: skipped
    });
  } catch (error) {
    console.error('Push notification error:', error);
    return NextResponse.json(
      { error: 'Failed to push notification' },
      { status: 500 }
    );
  }
}
