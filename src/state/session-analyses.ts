import type Database from 'better-sqlite3';

export interface SessionAnalysisRow {
  sourceThreadId: string;
  analysisSessionId: string;
  analyzedAt: string;
  userMsgCount: number;
  status: 'pending' | 'done';
}

interface DbRow {
  source_thread_id: string;
  analysis_session_id: string;
  analyzed_at: string;
  user_msg_count: number;
  status: string;
}

function fromRow(row: DbRow): SessionAnalysisRow {
  return {
    sourceThreadId: row.source_thread_id,
    analysisSessionId: row.analysis_session_id,
    analyzedAt: row.analyzed_at,
    userMsgCount: row.user_msg_count,
    status: row.status as 'pending' | 'done',
  };
}

export function getSessionAnalysis(
  db: Database.Database,
  sourceThreadId: string,
): SessionAnalysisRow | null {
  const stmt = db.prepare<[string], DbRow>(
    'SELECT * FROM session_analyses WHERE source_thread_id = ?',
  );
  const row = stmt.get(sourceThreadId);
  return row ? fromRow(row) : null;
}

export function upsertSessionAnalysis(
  db: Database.Database,
  row: SessionAnalysisRow,
): void {
  db.prepare(
    `INSERT INTO session_analyses
       (source_thread_id, analysis_session_id, analyzed_at, user_msg_count, status)
     VALUES (@sourceThreadId, @analysisSessionId, @analyzedAt, @userMsgCount, @status)
     ON CONFLICT(source_thread_id) DO UPDATE SET
       analysis_session_id = excluded.analysis_session_id,
       analyzed_at         = excluded.analyzed_at,
       user_msg_count      = excluded.user_msg_count,
       status              = excluded.status`,
  ).run({
    sourceThreadId: row.sourceThreadId,
    analysisSessionId: row.analysisSessionId,
    analyzedAt: row.analyzedAt,
    userMsgCount: row.userMsgCount,
    status: row.status,
  });
}

export function markSessionAnalysisDone(
  db: Database.Database,
  sourceThreadId: string,
): void {
  db.prepare(
    "UPDATE session_analyses SET status = 'done' WHERE source_thread_id = ?",
  ).run(sourceThreadId);
}

export interface EligibleSession {
  threadId: string;
  userMsgCount: number;
  channel: string | null;
  lastTs: string;
  /** GitHub fullName of the repo worked on in this session (e.g. "vibemafiaclub/context-hub"). */
  repo: string | null;
}

/**
 * Find threads eligible for auto-analysis:
 * - Last discord.message.out was 10+ minutes ago
 * - No discord.message.in after the last discord.message.out
 * - User sent 5+ messages in the thread
 * - Not already analyzed
 *
 * Note: claude.result and discord.message.out share the same timestamp, so we
 * cannot rely on "last event overall" — instead we compare per-type last timestamps.
 */
export function findEligibleSessionsForAnalysis(
  db: Database.Database,
): EligibleSession[] {
  const stmt = db.prepare<
    [],
    { thread_id: string; user_msg_count: number; channel: string | null; last_ts: string; repo: string | null }
  >(`
    SELECT
      e.thread_id,
      COUNT(CASE WHEN e.type = 'discord.message.in' THEN 1 END) AS user_msg_count,
      (SELECT channel FROM events WHERE thread_id = e.thread_id AND type = 'discord.message.out' ORDER BY ts DESC LIMIT 1) AS channel,
      (SELECT ts      FROM events WHERE thread_id = e.thread_id AND type = 'discord.message.out' ORDER BY ts DESC LIMIT 1) AS last_ts,
      (SELECT repo    FROM sessions WHERE thread_id = e.thread_id) AS repo
    FROM events e
    WHERE e.thread_id IS NOT NULL
      AND e.thread_id NOT IN (SELECT source_thread_id FROM session_analyses)
    GROUP BY e.thread_id
    HAVING
      last_ts IS NOT NULL
      AND datetime(last_ts) < datetime('now', '-10 minutes')
      AND (
        (SELECT MAX(ts) FROM events WHERE thread_id = e.thread_id AND type = 'discord.message.in')
        <=
        last_ts
      )
      AND user_msg_count >= 5
  `);
  return stmt.all().map((row) => ({
    threadId: row.thread_id,
    userMsgCount: row.user_msg_count,
    channel: row.channel,
    lastTs: row.last_ts,
    repo: row.repo,
  }));
}
