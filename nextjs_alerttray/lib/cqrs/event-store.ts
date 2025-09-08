import { Event } from '@/types';
import { getUserWriteDatabase } from '@/lib/infrastructure/database/connection';

export function assert(condition: any, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export class EventStore {
  async appendEvents(userId: string, events: Event[]): Promise<void> {
    assert(userId, "User ID is required");
    assert(events.length > 0, "At least one event required");
    
    const db = getUserWriteDatabase(userId);
    
    const insert = db.prepare(`
      INSERT INTO events (
        aggregate_id, aggregate_type, event_type, 
        event_version, event_data, metadata, 
        created_at, sequence_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const getLastSequence = db.prepare(
      'SELECT MAX(sequence_number) as max_seq FROM events'
    );
    
    db.transaction(() => {
      const result = getLastSequence.get() as { max_seq: number | null };
      let nextSequence = (result.max_seq || 0) + 1;
      
      for (const event of events) {
        insert.run(
          event.aggregateId,
          event.aggregateType,
          event.eventType,
          event.eventVersion,
          JSON.stringify(event.eventData),
          event.metadata ? JSON.stringify(event.metadata) : null,
          event.createdAt.toISOString(),
          nextSequence++
        );
      }
    })();
    
    db.close();
  }
  
  async getEvents(
    userId: string, 
    fromSequence: number = 0,
    aggregateId?: string
  ): Promise<Event[]> {
    const db = getUserWriteDatabase(userId);
    
    let query = 'SELECT * FROM events WHERE sequence_number > ?';
    const params: any[] = [fromSequence];
    
    if (aggregateId) {
      query += ' AND aggregate_id = ?';
      params.push(aggregateId);
    }
    
    query += ' ORDER BY sequence_number ASC';
    
    const stmt = db.prepare(query);
    const rows = stmt.all(...params) as any[];
    
    db.close();
    
    return rows.map(row => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      eventType: row.event_type,
      eventVersion: row.event_version,
      eventData: JSON.parse(row.event_data),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: new Date(row.created_at),
      sequenceNumber: row.sequence_number
    }));
  }
}