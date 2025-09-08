import { NextRequest, NextResponse } from 'next/server';
import { AuthService } from '@/lib/infrastructure/security/auth';
import { ApiSecurity } from '@/lib/infrastructure/security/api-security';
import { CommandBus } from '@/lib/cqrs/command-bus';
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
    const { name } = body;
    
    if (!name) {
      return NextResponse.json(
        { error: 'API key name is required' },
        { status: 400 }
      );
    }
    
    // Create API key
    const { id: apiKeyId, key } = await ApiSecurity.createApiKey(sessionData.user.id, name);
    
    // Record event
    const commandBus = new CommandBus();
    await commandBus.dispatch({
      userId: sessionData.user.id,
      aggregateId: apiKeyId,
      type: 'CreateApiKey',
      payload: {
        name,
        keyHash: ApiSecurity.hashApiKey(key)
      }
    });
    
    return NextResponse.json({
      success: true,
      apiKey: {
        id: apiKeyId,
        key,
        name,
        message: 'Save this key securely. It will not be shown again.'
      }
    });
  } catch (error) {
    console.error('Create API key error:', error);
    return NextResponse.json(
      { error: 'Failed to create API key' },
      { status: 500 }
    );
  }
}