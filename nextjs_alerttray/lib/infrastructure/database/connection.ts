import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { LegacyPushTaskRow } from '@/types/db-types';

const DATABASE_PATH = process.env.DATABASE_PATH || './data';

export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return !!row;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some(c => c.name === column);
}

/** Idempotently add a column to an existing table (SQLite has no ADD COLUMN IF NOT EXISTS). */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
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
      phone_number TEXT,
      notification_email TEXT,
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

  // Migrations for databases created before contact details existed.
  ensureColumn(db, 'users', 'phone_number', 'TEXT');
  ensureColumn(db, 'users', 'notification_email', 'TEXT');
  
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
    
    -- One row per (notification, channel, recipient). Replaces the APNS-only push_tasks table.
    CREATE TABLE IF NOT EXISTS delivery_tasks (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('apns', 'call', 'sms', 'email', 'emergency')),
      recipient TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
      data JSON,
      status TEXT CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      attempts INTEGER DEFAULT 0,
      last_attempt_at TIMESTAMP,
      completed_at TIMESTAMP,
      error_message TEXT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_task_status ON delivery_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_delivery_task_notification ON delivery_tasks(notification_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_task_channel ON delivery_tasks(channel);
    
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

  migrateLegacyPushTasks(db);
  
  return db;
}

/**
 * One-time migration: copy rows from the pre-multichannel `push_tasks` table
 * into `delivery_tasks` as channel='apns'. The old table is left in place
 * (renamed) so nothing is destroyed; it can be dropped by hand later.
 */
function migrateLegacyPushTasks(db: Database.Database): void {
  if (!tableExists(db, 'push_tasks')) return;

  const rows = db.prepare('SELECT * FROM push_tasks').all() as LegacyPushTaskRow[];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO delivery_tasks (
      id, notification_id, user_id, channel, recipient, title, message, severity,
      data, status, attempts, last_attempt_at, completed_at, error_message,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'apns', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const severityOf = db.prepare('SELECT severity FROM notifications WHERE id = ?');

  db.transaction(() => {
    for (const row of rows) {
      const n = severityOf.get(row.notification_id) as { severity: string } | undefined;
      insert.run(
        row.id, row.notification_id, row.user_id, row.device_token,
        row.title, row.message, n?.severity ?? 'medium',
        row.data, row.status, row.attempts, row.last_attempt_at,
        row.completed_at, row.error_message, row.created_at, row.updated_at
      );
    }
    db.exec('ALTER TABLE push_tasks RENAME TO push_tasks_legacy');
  })();

  console.log(`Migrated ${rows.length} legacy push_tasks rows into delivery_tasks`);
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
