import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/infrastructure/security/auth-middleware';
import { ApiSecurity } from '@/lib/infrastructure/security/api-security';

export async function GET(request: NextRequest) {
  try {
    const sessionData = await validateRequest(request);
    
    if (!sessionData) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    
    const apiKeys = await ApiSecurity.listApiKeys(sessionData.user.id);
    
    return NextResponse.json({
      success: true,
      apiKeys
    });
  } catch (error) {
    console.error('List API keys error:', error);
    return NextResponse.json(
      { error: 'Failed to list API keys' },
      { status: 500 }
    );
  }
}