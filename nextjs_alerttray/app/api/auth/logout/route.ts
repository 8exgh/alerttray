import { NextRequest, NextResponse } from 'next/server';
import { AuthService } from '@/lib/infrastructure/security/auth';

export async function POST(request: NextRequest) {
  try {
    const sessionToken = request.cookies.get('session')?.value;
    
    if (sessionToken) {
      await AuthService.deleteSession(sessionToken);
    }
    
    const response = NextResponse.json({ success: true });
    
    // Clear session cookie
    response.cookies.delete('session');
    
    return response;
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    );
  }
}