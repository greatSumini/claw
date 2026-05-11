import type Database from 'better-sqlite3';

interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    name: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id          TEXT PRIMARY KEY,
        claude_session_id  TEXT NOT NULL,
        repo               TEXT NOT NULL,
        cwd                TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mail_state (
        account            TEXT PRIMARY KEY,
        last_history_id    TEXT,
        last_polled_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS sender_policies (
        email              TEXT NOT NULL,
        account            TEXT NOT NULL,
        policy             TEXT NOT NULL,
        reason             TEXT,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (email, account)
      );

      CREATE TABLE IF NOT EXISTS mail_threads (
        discord_thread_id  TEXT PRIMARY KEY,
        gmail_msg_id       TEXT NOT NULL,
        gmail_thread_id    TEXT NOT NULL,
        account            TEXT NOT NULL,
        subject            TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'awaiting_user',
        created_at         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                 TEXT NOT NULL,
        type               TEXT NOT NULL,
        channel            TEXT,
        thread_id          TEXT,
        summary            TEXT NOT NULL,
        meta_json          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
    `,
  },
  {
    name: '002_session_analyses',
    sql: `
      CREATE TABLE IF NOT EXISTS session_analyses (
        source_thread_id   TEXT PRIMARY KEY,
        analysis_session_id TEXT NOT NULL,
        analyzed_at        TEXT NOT NULL,
        user_msg_count     INTEGER NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending'
      );
    `,
  },
  {
    name: '003_message_queue',
    sql: `
      CREATE TABLE IF NOT EXISTS message_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id  TEXT NOT NULL,
        message_id  TEXT NOT NULL UNIQUE,
        queued_at   TEXT NOT NULL
      );
    `,
  },
  {
    name: '004_session_skill_cache',
    sql: `
      ALTER TABLE sessions ADD COLUMN last_skill TEXT;
      ALTER TABLE sessions ADD COLUMN last_response TEXT;
    `,
  },
  {
    name: '005_events_fts',
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        summary,
        content='events',
        content_rowid='id',
        tokenize='unicode61'
      );

      INSERT INTO events_fts(events_fts) VALUES('rebuild');

      CREATE TRIGGER IF NOT EXISTS events_fts_ins AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, summary) VALUES (new.id, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS events_fts_upd AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
        INSERT INTO events_fts(rowid, summary) VALUES (new.id, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS events_fts_del AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
      END;
    `,
  },
  {
    name: '006_skill_proposals',
    sql: `
      CREATE TABLE IF NOT EXISTS skill_proposals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              TEXT NOT NULL,
        kind            TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL,
        content         TEXT NOT NULL,
        repo_full_name  TEXT,
        source_thread_id TEXT,
        status          TEXT NOT NULL DEFAULT 'pending'
      );
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `);

  const isApplied = db.prepare<[string], { name: string }>(
    'SELECT name FROM _migrations WHERE name = ?',
  );
  const recordApplied = db.prepare<[string, string]>(
    'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const migration of MIGRATIONS) {
    const existing = isApplied.get(migration.name);
    if (existing) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      recordApplied.run(migration.name, new Date().toISOString());
    });
    apply();
  }
}
