import { NextRequest, NextResponse } from 'next/server';
import { AuthService } from '@/lib/infrastructure/security/auth';
import { getSystemDatabase } from '@/lib/infrastructure/database/connection';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { v4 as uuidv4 } from 'uuid';
import { initializeSystem } from '@/lib/startup';

export async function POST(request: NextRequest) {
  await initializeSystem();
  
  try {
    const sessionToken = request.cookies.get('session')?.value;
    
    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    
    const sessionData = await AuthService.validateSession(sessionToken);
    
    if (!sessionData) {
      return NextResponse.json(
        { error: 'Invalid session' },
        { status: 401 }
      );
    }
    
    const body = await request.json();
    const { token, deviceName, platform = 'ios' } = body;
    
    if (!token) {
      return NextResponse.json(
        { error: 'Device token is required' },
        { status: 400 }
      );
    }
    
    const db = getSystemDatabase();
    
    try {
      // Check if this token already exists
      const existing = db.prepare(`
        SELECT id FROM device_tokens WHERE token = ?
      `).get(token) as any;
      
      let deviceId: string;
      
      if (existing) {
        // Update existing device
        deviceId = existing.id;
        db.prepare(`
          UPDATE device_tokens 
          SET user_id = ?, device_name = ?, platform = ?, updated_at = ?
          WHERE id = ?
        `).run(
          sessionData.user.id,
          deviceName || 'Unknown Device',
          platform,
          new Date().toISOString(),
          deviceId
        );
      } else {
        // Insert new device
        deviceId = uuidv4();
        db.prepare(`
          INSERT INTO device_tokens (id, user_id, token, device_name, platform, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          deviceId,
          sessionData.user.id,
          token,
          deviceName || 'Unknown Device',
          platform,
          new Date().toISOString(),
          new Date().toISOString()
        );
      }
      
      // Create device registration event
      const commandBus = new CommandBus();
      await commandBus.dispatch({
        userId: sessionData.user.id,
        aggregateId: deviceId,
        type: 'RegisterDevice',
        payload: {
          token,
          deviceName,
          platform
        }
      });
      
      return NextResponse.json({
        success: true,
        deviceId,
        message: 'Device registered successfully'
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Device registration error:', error);
    return NextResponse.json(
      { error: 'Failed to register device' },
      { status: 500 }
    );
  }
}