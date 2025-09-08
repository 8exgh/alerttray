import { NextRequest, NextResponse } from 'next/server';
import { ApiSecurity } from '@/lib/infrastructure/security/api-security';
import { getSystemDatabase } from '@/lib/infrastructure/database/connection';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { v4 as uuidv4 } from 'uuid';
import { initializeSystem } from '@/lib/startup';
import type { DeviceTokenRow } from '@/types/db-types';

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
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    if (!validSeverities.includes(body.severity)) {
      return NextResponse.json(
        { error: 'Invalid severity. Must be: low, medium, high, or critical' },
        { status: 400 }
      );
    }
    
    // Get device tokens for user (optional - notification will be created regardless)
    const db = getSystemDatabase();
    const devices = db.prepare(`
      SELECT token FROM device_tokens WHERE user_id = ?
    `).all(keyData.userId) as Pick<DeviceTokenRow, 'token'>[];
    db.close();
    
    const commandBus = new CommandBus();
    const notificationId = uuidv4();
    
    // Create notification and schedule push tasks (if devices exist)
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
        deviceTokens: devices.map(d => d.token) // Will be empty array if no devices
      }
    });
    
    return NextResponse.json({
      success: true,
      notificationId
    });
  } catch (error) {
    console.error('Push notification error:', error);
    return NextResponse.json(
      { error: 'Failed to push notification' },
      { status: 500 }
    );
  }
}