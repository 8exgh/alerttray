import { getSystemDatabase } from '../database/connection';
import type { UserContactDetails } from '@/lib/delivery/routing-policy';
import type { DeviceTokenRow, UserRow } from '@/types/db-types';

export interface StoredContactDetails {
  email: string;
  phoneNumber: string | null;
  notificationEmail: string | null;
}

export class ContactDetailsService {
  static getForUser(userId: string): StoredContactDetails | null {
    const db = getSystemDatabase();
    try {
      const row = db.prepare(
        'SELECT email, phone_number, notification_email FROM users WHERE id = ?'
      ).get(userId) as Pick<UserRow, 'email' | 'phone_number' | 'notification_email'> | undefined;
      if (!row) return null;
      return {
        email: row.email,
        phoneNumber: row.phone_number,
        notificationEmail: row.notification_email
      };
    } finally {
      db.close();
    }
  }
  
  static update(userId: string, details: { phoneNumber: string | null; notificationEmail: string | null }): void {
    const db = getSystemDatabase();
    try {
      db.prepare(`
        UPDATE users SET phone_number = ?, notification_email = ? WHERE id = ?
      `).run(details.phoneNumber, details.notificationEmail, userId);
    } finally {
      db.close();
    }
  }
  
  /**
   * Everything the routing policy needs to turn a severity into concrete
   * delivery targets: phone number, email and registered device tokens.
   */
  static getDeliveryContact(userId: string): UserContactDetails {
    const db = getSystemDatabase();
    try {
      const user = db.prepare(
        'SELECT email, phone_number, notification_email FROM users WHERE id = ?'
      ).get(userId) as Pick<UserRow, 'email' | 'phone_number' | 'notification_email'> | undefined;
      
      const devices = db.prepare(
        'SELECT token FROM device_tokens WHERE user_id = ?'
      ).all(userId) as Pick<DeviceTokenRow, 'token'>[];
      
      return {
        phoneNumber: user?.phone_number ?? null,
        notificationEmail: user?.notification_email || user?.email || null,
        deviceTokens: devices.map(d => d.token)
      };
    } finally {
      db.close();
    }
  }
}
