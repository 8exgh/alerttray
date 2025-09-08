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
    const { apiKeyId } = body;
    
    if (!apiKeyId) {
      return NextResponse.json(
        { error: 'API key ID is required' },
        { status: 400 }
      );
    }
    
    // Revoke API key
    await ApiSecurity.revokeApiKey(apiKeyId);
    
    // Record event
    const commandBus = new CommandBus();
    await commandBus.dispatch({
      userId: sessionData.user.id,
      aggregateId: apiKeyId,
      type: 'RevokeApiKey',
      payload: {
        apiKeyId
      }
    });
    
    return NextResponse.json({
      success: true,
      message: 'API key revoked successfully'
    });
  } catch (error) {
    console.error('Revoke API key error:', error);
    return NextResponse.json(
      { error: 'Failed to revoke API key' },
      { status: 500 }
    );
  }
}