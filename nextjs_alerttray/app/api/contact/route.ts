import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { ContactDetailsService } from '@/lib/infrastructure/users/contact-details';
import { isValidEmail, normalizePhoneNumber, SEVERITY_CHANNEL_POLICY, FALLBACK_CHANNEL } from '@/lib/delivery/routing-policy';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { initializeSystem } from '@/lib/startup';

/** Current user's alert contact details plus the routing policy (for display). */
export async function GET(request: NextRequest) {
  try {
    const sessionData = await validateRequest(request);
    
    if (!sessionData) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    
    const details = ContactDetailsService.getForUser(sessionData.user.id);
    
    return NextResponse.json({
      success: true,
      contact: {
        email: details?.email ?? sessionData.user.email,
        phoneNumber: details?.phoneNumber ?? null,
        notificationEmail: details?.notificationEmail ?? null
      },
      policy: SEVERITY_CHANNEL_POLICY,
      fallbackChannel: FALLBACK_CHANNEL
    });
  } catch (error) {
    console.error('Get contact details error:', error);
    return NextResponse.json({ error: 'Failed to get contact details' }, { status: 500 });
  }
}

/** Update phone number (E.164) and/or the address alerts are emailed to. */
export async function PUT(request: NextRequest) {
  await initializeSystem();
  
  try {
    const sessionData = await validateRequest(request);
    
    if (!sessionData) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    
    const body = await request.json();
    
    let phoneNumber: string | null = null;
    if (typeof body.phoneNumber === 'string' && body.phoneNumber.trim() !== '') {
      phoneNumber = normalizePhoneNumber(body.phoneNumber);
      if (!phoneNumber) {
        return NextResponse.json(
          { error: 'Phone number must be in international E.164 format, e.g. +14155552671' },
          { status: 400 }
        );
      }
    }
    
    let notificationEmail: string | null = null;
    if (typeof body.notificationEmail === 'string' && body.notificationEmail.trim() !== '') {
      notificationEmail = body.notificationEmail.trim();
      if (!isValidEmail(notificationEmail!)) {
        return NextResponse.json({ error: 'Invalid notification email address' }, { status: 400 });
      }
    }
    
    ContactDetailsService.update(sessionData.user.id, { phoneNumber, notificationEmail });
    
    // Record the change in the user's event stream
    const commandBus = new CommandBus();
    await commandBus.dispatch({
      userId: sessionData.user.id,
      aggregateId: sessionData.user.id,
      type: 'UpdateContactDetails',
      payload: { phoneNumber, notificationEmail }
    });
    
    return NextResponse.json({
      success: true,
      contact: {
        email: sessionData.user.email,
        phoneNumber,
        notificationEmail
      }
    });
  } catch (error) {
    console.error('Update contact details error:', error);
    return NextResponse.json({ error: 'Failed to update contact details' }, { status: 500 });
  }
}
