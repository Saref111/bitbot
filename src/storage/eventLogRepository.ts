import type { DatabaseSync } from 'node:sqlite';
import type { EventLogRow } from './types.js';

export interface NewEvent {
  dealId: string | null;
  eventType: string;
  payload?: unknown;
  createdAt: number;
}

function mapRow(row: Record<string, unknown>): EventLogRow {
  return {
    id: row.id as number,
    dealId: row.deal_id as string | null,
    eventType: row.event_type as string,
    payloadJson: row.payload_json as string | null,
    createdAt: row.created_at as number,
  };
}

export function appendEvent(db: DatabaseSync, event: NewEvent): void {
  db.prepare(
    `INSERT INTO event_log (deal_id, event_type, payload_json, created_at) VALUES (@dealId, @eventType, @payloadJson, @createdAt)`,
  ).run({
    dealId: event.dealId,
    eventType: event.eventType,
    payloadJson: event.payload !== undefined ? JSON.stringify(event.payload) : null,
    createdAt: event.createdAt,
  });
}

export function getEventsByDeal(db: DatabaseSync, dealId: string): EventLogRow[] {
  const rows = db
    .prepare('SELECT * FROM event_log WHERE deal_id = @dealId ORDER BY id ASC')
    .all({ dealId });
  return rows.map(mapRow);
}
