import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { ApiSecurity } from '@/lib/infrastructure/security/api-security';
import { CommandBus } from '@/lib/cqrs/command-bus';
import { initializeSystem } from '@/lib/startup';

/**
 * Re-enable a revoked API key. The key's original secret becomes valid again,
 * so integrations that still hold it start working without being reconfigured.
 */
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
    
    const reactivated = await ApiSecurity.reactivateApiKey(sessionData.user.id, apiKeyId);
    if (!reactivated) {
      return NextResponse.json(
        { error: 'No revoked API key with that ID' },
        { status: 404 }
      );
    }
    
    // Record event
    const commandBus = new CommandBus();
    await commandBus.dispatch({
      userId: sessionData.user.id,
      aggregateId: apiKeyId,
      type: 'ReactivateApiKey',
      payload: {
        apiKeyId
      }
    });
    
    return NextResponse.json({
      success: true,
      message: 'API key re-enabled successfully'
    });
  } catch (error) {
    console.error('Reactivate API key error:', error);
    return NextResponse.json(
      { error: 'Failed to re-enable API key' },
      { status: 500 }
    );
  }
}
