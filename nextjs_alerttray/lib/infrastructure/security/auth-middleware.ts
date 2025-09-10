import { NextRequest } from 'next/server';
import { AuthService } from './auth';

export async function validateRequest(request: NextRequest) {
  // First try cookie-based auth (for web clients)
  const sessionToken = request.cookies.get('session')?.value;
  
  if (sessionToken) {
    const sessionData = await AuthService.validateSession(sessionToken);
    if (sessionData) {
      return sessionData;
    }
  }
  
  // Then try Bearer token auth (for mobile clients)
  const authHeader = request.headers.get('Authorization');
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const sessionData = await AuthService.validateSession(token);
    if (sessionData) {
      return sessionData;
    }
  }
  
  // No valid auth found
  return null;
}