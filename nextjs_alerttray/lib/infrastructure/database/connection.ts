import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATABASE_PATH = process.env.DATABASE_PATH || './data';

export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function getUserWriteDatabase(userId: string): Database.Database {
  const userDbPath = path.join(DATABASE_PATH, 'users', userId);
  ensureDirectoryExists(userDbPath);
  
  const dbFile = path.join(userDbPath, 'write.db');
  const db = new Database(dbFile);
  
  // Create events table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate_id TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_version INTEGER NOT NULL,
      event_data JSON NOT NULL,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sequence_number INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_aggregate ON events(aggregate_id, aggregate_type);
    CREATE INDEX IF NOT EXISTS idx_created_at ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_sequence ON events(sequence_number);
  `);
  
  return db;
}

export function getSystemDatabase(): Database.Database {
  const systemDbPath = path.join(DATABASE_PATH, 'system');
  ensureDirectoryExists(systemDbPath);
  
  const dbFile = path.join(systemDbPath, 'system.db');
  const db = new Database(dbFile);
  
  // Create system tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_session_expiry ON sessions(expires_at);
    
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      name TEXT,
      last_used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      revoked_at TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_api_key_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_key_user ON api_keys(user_id);
    
    CREATE TABLE IF NOT EXISTS device_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      device_name TEXT,
      platform TEXT DEFAULT 'ios',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_device_token ON device_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_device_user ON device_tokens(user_id);
  `);
  
  return db;
}

export function getReadModelDatabase(): Database.Database {
  const readModelPath = path.join(DATABASE_PATH, 'read_model');
  ensureDirectoryExists(readModelPath);
  
  const dbFile = path.join(readModelPath, 'read.db');
  const db = new Database(dbFile);
  
  // Create read model tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      purpose_id TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT CHECK(severity IN ('low', 'medium', 'high', 'critical')),
      metadata JSON,
      status TEXT CHECK(status IN ('pending', 'delivered', 'failed', 'read')),
      delivered_at TIMESTAMP,
      read_at TIMESTAMP,
      created_at TIMESTAMP,
      updated_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notification_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notification_status ON notifications(status);
    CREATE INDEX IF NOT EXISTS idx_notification_created ON notifications(created_at DESC);
    
    CREATE TABLE IF NOT EXISTS push_tasks (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      device_token TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      data JSON,
      status TEXT CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      attempts INTEGER DEFAULT 0,
      last_attempt_at TIMESTAMP,
      completed_at TIMESTAMP,
      error_message TEXT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_push_task_status ON push_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_push_task_notification ON push_tasks(notification_id);
    
    CREATE TABLE IF NOT EXISTS notification_purposes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT,
      icon TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP,
      updated_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_purpose_user ON notification_purposes(user_id);
    CREATE INDEX IF NOT EXISTS idx_purpose_active ON notification_purposes(active);
    
    CREATE TABLE IF NOT EXISTS projection_checkpoints (
      user_id TEXT PRIMARY KEY,
      last_processed_sequence INTEGER NOT NULL,
      last_processed_at TIMESTAMP
    );
  `);
  
  return db;
}

export function getAllUserIds(): string[] {
  const usersPath = path.join(DATABASE_PATH, 'users');
  ensureDirectoryExists(usersPath);
  
  try {
    const userDirs = fs.readdirSync(usersPath)
      .filter(name => {
        const fullPath = path.join(usersPath, name);
        return fs.statSync(fullPath).isDirectory();
      });
    return userDirs;
  } catch (error) {
    console.error('Error reading user directories:', error);
    return [];
  }
}