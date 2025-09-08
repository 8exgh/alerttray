// Database row result types for better-sqlite3

export interface EventRow {
  id: number;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  event_version: number;
  event_data: string;
  metadata: string | null;
  created_at: string;
  sequence_number: number;
}

export interface MaxSequenceResult {
  max_seq: number | null;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export interface SessionUserRow extends SessionRow {
  email: string;
  password_hash: string;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  key_hash: string;
  name: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface DeviceTokenRow {
  id: string;
  user_id: string;
  token: string;
  device_name: string | null;
  platform: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  purpose_id: string;
  title: string;
  message: string;
  severity: string;
  metadata: string | null;
  status: string;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PushTaskRow {
  id: string;
  notification_id: string;
  user_id: string;
  device_token: string;
  title: string;
  message: string;
  data: string | null;
  status: string;
  attempts: number;
  last_attempt_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationPurposeRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectionCheckpointRow {
  user_id: string;
  last_processed_sequence: number;
  last_processed_at: string | null;
}

export interface CountResult {
  count: number;
}

export interface HealthCheckResult {
  healthy: number;
}