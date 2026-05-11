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

// ---------------------------------------------------------------------------
// FTS5 full-text search
// ---------------------------------------------------------------------------

export interface EventSearchResult {
  id: number;
  ts: string;
  type: string;
  channel: string | null;
  threadId: string | null;
  summary: string;
  snippet: string;
}

function sanitizeFts5Query(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '""';
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
}

export function searchEvents(
  db: Database.Database,
  query: string,
  limit = 15,
): EventSearchResult[] {
  if (!query || !query.trim()) return [];
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('searchEvents: limit must be a positive integer');
  }
  const safe = sanitizeFts5Query(query);
  const stmt = db.prepare<
    [string, number],
    {
      id: number;
      ts: string;
      type: string;
      channel: string | null;
      thread_id: string | null;
      summary: string;
      snippet: string;
    }
  >(
    `SELECT e.id, e.ts, e.type, e.channel, e.thread_id, e.summary,
            snippet(events_fts, 0, '**', '**', '…', 15) AS snippet
     FROM events_fts
     JOIN events e ON e.id = events_fts.rowid
     WHERE events_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
  );
  const rows = stmt.all(safe, limit);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    type: r.type,
    channel: r.channel,
    threadId: r.thread_id,
    summary: r.summary,
    snippet: r.snippet,
  }));
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
