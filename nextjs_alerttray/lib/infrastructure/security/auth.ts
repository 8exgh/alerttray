import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { getSystemDatabase } from '../database/connection';
import { User, Session } from '@/types';
import { v4 as uuidv4 } from 'uuid';

export class AuthService {
  private static SALT_ROUNDS = 10;
  private static SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
  
  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.SALT_ROUNDS);
  }
  
  static async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }
  
  static generateToken(): string {
    return randomBytes(32).toString('hex');
  }
  
  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
  
  static async createUser(email: string, password: string): Promise<User> {
    const db = getSystemDatabase();
    
    try {
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingUser) {
        throw new Error('User already exists');
      }
      
      const userId = uuidv4();
      const passwordHash = await this.hashPassword(password);
      const now = new Date().toISOString();
      
      db.prepare(`
        INSERT INTO users (id, email, password_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(userId, email, passwordHash, now);
      
      return {
        id: userId,
        email,
        passwordHash,
        createdAt: new Date(now)
      };
    } finally {
      db.close();
    }
  }
  
  static async authenticateUser(email: string, password: string): Promise<User | null> {
    const db = getSystemDatabase();
    
    try {
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
      
      if (!row) {
        return null;
      }
      
      const isValid = await this.verifyPassword(password, row.password_hash);
      
      if (!isValid) {
        return null;
      }
      
      return {
        id: row.id,
        email: row.email,
        passwordHash: row.password_hash,
        createdAt: new Date(row.created_at)
      };
    } finally {
      db.close();
    }
  }
  
  static async createSession(userId: string): Promise<{ session: Session; token: string }> {
    const db = getSystemDatabase();
    
    try {
      const sessionId = uuidv4();
      const token = this.generateToken();
      const tokenHash = this.hashToken(token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.SESSION_DURATION);
      
      db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, userId, tokenHash, expiresAt.toISOString(), now.toISOString());
      
      const session: Session = {
        id: sessionId,
        userId,
        tokenHash,
        expiresAt,
        createdAt: now
      };
      
      return { session, token };
    } finally {
      db.close();
    }
  }
  
  static async validateSession(token: string): Promise<{ user: User; session: Session } | null> {
    const db = getSystemDatabase();
    
    try {
      const tokenHash = this.hashToken(token);
      const now = new Date().toISOString();
      
      const row = db.prepare(`
        SELECT s.*, u.* 
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.token_hash = ? AND s.expires_at > ?
      `).get(tokenHash, now) as any;
      
      if (!row) {
        return null;
      }
      
      const user: User = {
        id: row.user_id,
        email: row.email,
        passwordHash: row.password_hash,
        createdAt: new Date(row.created_at)
      };
      
      const session: Session = {
        id: row.id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        expiresAt: new Date(row.expires_at),
        createdAt: new Date(row.created_at)
      };
      
      return { user, session };
    } finally {
      db.close();
    }
  }
  
  static async deleteSession(token: string): Promise<void> {
    const db = getSystemDatabase();
    
    try {
      const tokenHash = this.hashToken(token);
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    } finally {
      db.close();
    }
  }
  
  static async cleanupExpiredSessions(): Promise<void> {
    const db = getSystemDatabase();
    
    try {
      const now = new Date().toISOString();
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    } finally {
      db.close();
    }
  }
}