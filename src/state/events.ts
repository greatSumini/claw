import type Database from 'better-sqlite3';

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  channel: string | null;
  threadId: string | null;
  summary: string;
  metaJson: string | null;
}

interface EventDbRow {
  id: number;
  ts: string;
  type: string;
  channel: string | null;
  thread_id: string | null;
  summary: string;
  meta_json: string | null;
}

function fromRow(row: EventDbRow): EventRow {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    channel: row.channel,
    threadId: row.thread_id,
    summary: row.summary,
    metaJson: row.meta_json,
  };
}

export interface LogEventArgs {
  type: string;
  channel?: string;
  threadId?: string;
  summary: string;
  meta?: object;
}

export function logEvent(db: Database.Database, args: LogEventArgs): void {
  if (!args.type) throw new Error('logEvent: type is required');
  if (typeof args.summary !== 'string') {
    throw new Error('logEvent: summary must be a string');
  }
  const ts = new Date().toISOString();
  const metaJson = args.meta === undefined ? null : JSON.stringify(args.meta);
  const stmt = db.prepare(
    `INSERT INTO events (ts, type, channel, thread_id, summary, meta_json)
     VALUES (@ts, @type, @channel, @threadId, @summary, @metaJson)`,
  );
  stmt.run({
    ts,
    type: args.type,
    channel: args.channel ?? null,
    threadId: args.threadId ?? null,
    summary: args.summary,
    metaJson,
  });
}

export function listRecentEvents(db: Database.Database, limit = 100): EventRow[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('listRecentEvents: limit must be a positive integer');
  }
  const stmt = db.prepare<[number], EventDbRow>(
    `SELECT id, ts, type, channel, thread_id, summary, meta_json
     FROM events ORDER BY ts DESC LIMIT ?`,
  );
  return stmt.all(limit).map(fromRow);
}

export function listEventsByThread(
  db: Database.Database,
  threadId: string,
  limit = 200,
): EventRow[] {
  if (!threadId) throw new Error('listEventsByThread: threadId is required');
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('listEventsByThread: limit must be a positive integer');
  }
  const stmt = db.prepare<[string, number], EventDbRow>(
    `SELECT id, ts, type, channel, thread_id, summary, meta_json
     FROM events WHERE thread_id = ? ORDER BY ts ASC LIMIT ?`,
  );
  return stmt.all(threadId, limit).map(fromRow);
}

export function countEventsByType(
  db: Database.Database,
  type: string,
  sinceIso?: string,
): number {
  if (!type) throw new Error('countEventsByType: type is required');
  if (sinceIso !== undefined) {
    const stmt = db.prepare<[string, string], { c: number }>(
      'SELECT COUNT(*) AS c FROM events WHERE type = ? AND ts >= ?',
    );
    const row = stmt.get(type, sinceIso);
    return row?.c ?? 0;
  }
  const stmt = db.prepare<[string], { c: number }>(
    'SELECT COUNT(*) AS c FROM events WHERE type = ?',
  );
  const row = stmt.get(type);
  return row?.c ?? 0;
}
