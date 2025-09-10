import { createHmac, createHash, randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSystemDatabase } from '../database/connection';
import { v4 as uuidv4 } from 'uuid';
import type { ApiKeyRow } from '@/types/db-types';

export class ApiSecurity {
  static generateApiKey(): { key: string; hash: string } {
    const randomPart = randomBytes(16).toString('hex');
    const key = `atk_${randomPart}`;
    const hash = createHash('sha256').update(key).digest('hex');
    return { key, hash };
  }
  
  static hashApiKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
  
  static async createApiKey(userId: string, name: string): Promise<{ id: string; key: string }> {
    const db = getSystemDatabase();
    
    try {
      // Revoke existing active keys
      db.prepare(`
        UPDATE api_keys 
        SET revoked_at = ? 
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(new Date().toISOString(), userId);
      
      const { key, hash } = this.generateApiKey();
      const apiKeyId = uuidv4();
      const now = new Date().toISOString();
      
      db.prepare(`
        INSERT INTO api_keys (id, user_id, key_hash, name, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(apiKeyId, userId, hash, name, now);
      
      return { id: apiKeyId, key };
    } finally {
      db.close();
    }
  }
  
  static async validateApiKey(key: string): Promise<{ userId: string; apiKeyId: string } | null> {
    const db = getSystemDatabase();
    
    try {
      const keyHash = this.hashApiKey(key);
      
      const row = db.prepare(`
        SELECT id, user_id FROM api_keys 
        WHERE key_hash = ? AND revoked_at IS NULL
      `).get(keyHash) as Pick<ApiKeyRow, 'id' | 'user_id'> | undefined;
      
      if (!row) {
        return null;
      }
      
      // Update last used
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
        .run(new Date().toISOString(), row.id);
      
      return { userId: row.user_id, apiKeyId: row.id };
    } finally {
      db.close();
    }
  }
  
  static async revokeApiKey(apiKeyId: string): Promise<void> {
    const db = getSystemDatabase();
    
    try {
      db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?')
        .run(new Date().toISOString(), apiKeyId);
    } finally {
      db.close();
    }
  }
  
  static async listApiKeys(userId: string): Promise<Partial<ApiKeyRow>[]> {
    const db = getSystemDatabase();
    
    try {
      const rows = db.prepare(`
        SELECT id, name, last_used_at, created_at, revoked_at
        FROM api_keys 
        WHERE user_id = ?
        ORDER BY created_at DESC
      `).all(userId) as ApiKeyRow[];
      
      return rows.map(row => ({
        id: row.id,
        name: row.name,
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
        createdAt: new Date(row.created_at),
        revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
        active: !row.revoked_at
      }));
    } finally {
      db.close();
    }
  }
}

// Internal API security helpers
const INTERNAL_API_KEY = process.env.BACKGROUND_PROCESSOR_API_KEY || 'development-key';

export function createSignature(body: string): string {
  return createHmac('sha256', INTERNAL_API_KEY)
    .update(body)
    .digest('hex');
}

export function verifySignature(body: string, signature: string): boolean {
  const expectedSignature = createSignature(body);
  return signature === expectedSignature;
}

export async function withInternalAuth(
  request: NextRequest,
  handler: (req: NextRequest) => Promise<NextResponse>
): Promise<NextResponse> {
  try {
    const apiKey = request.headers.get('X-API-Key');
    const signature = request.headers.get('X-Signature');
    
    // Log authentication attempt
    console.log(`🔐 Internal API auth attempt:`);
    console.log(`  - Method: ${request.method}`);
    console.log(`  - URL: ${request.url}`);
    console.log(`  - X-API-Key received: ${apiKey ? apiKey.substring(0, 3) + '...' : 'None'}`);
    console.log(`  - Expected key starts with: ${INTERNAL_API_KEY.substring(0, 3)}...`);
    console.log(`  - X-Signature received: ${signature ? signature.substring(0, 8) + '...' : 'None'}`);
    
    if (!apiKey || apiKey !== INTERNAL_API_KEY) {
      console.log(`  ❌ API Key mismatch - received: ${apiKey ? 'present but wrong' : 'missing'}`);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // For GET requests, verify empty body signature
    if (request.method === 'GET') {
      const expectedSig = createSignature('');
      console.log(`  - Expected signature: ${expectedSig.substring(0, 8)}...`);
      
      if (!signature || !verifySignature('', signature)) {
        console.log(`  ❌ Signature verification failed`);
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    }
    
    console.log(`  ✅ Authentication successful`);
    return await handler(request);
  } catch (error) {
    console.error('Internal API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export function createInternalResponse(data: unknown): NextResponse {
  return NextResponse.json(data);
}