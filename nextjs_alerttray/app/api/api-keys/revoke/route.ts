import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { ApiSecurity } from '@/lib/infrastructure/security/api-security';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { initializeSystem } from '@/lib/startup';

export async function POST(request: NextRequest) {
  await initializeSystem();
  
  try {
    const sessionData = await validateRequest(request);
    
    if (!sessionData) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    
    const body = await request.json();
    const { apiKeyId } = body;
    
    if (!apiKeyId || typeof apiKeyId !== 'string') {
      return NextResponse.json(
        { error: 'API key ID is required' },
        { status: 400 }
      );
    }
    
    // Only the owner's own active keys can be revoked
    const revoked = await ApiSecurity.revokeApiKey(sessionData.user.id, apiKeyId);
    if (!revoked) {
      return NextResponse.json(
        { error: 'No active API key with that ID' },
        { status: 404 }
      );
    }
    
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
