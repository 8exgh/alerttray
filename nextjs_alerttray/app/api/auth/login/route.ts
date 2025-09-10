import { NextRequest, NextResponse } from 'next/server';
import { AuthService } from '@/lib/infrastructure/security/auth';
import { initializeSystem } from '@/lib/startup';

export async function POST(request: NextRequest) {
  await initializeSystem();
  
  try {
    const body = await request.json();
    const { email, password } = body;
    
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      );
    }
    
    const user = await AuthService.authenticateUser(email, password);
    
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }
    
    const { token } = await AuthService.createSession(user.id);
    
    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email
      },
      token: token // Include token in response for mobile clients
    });
    
    // Set session cookie for web clients
    response.cookies.set('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 // 7 days
    });
    
    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Failed to login' },
      { status: 500 }
    );
  }
}