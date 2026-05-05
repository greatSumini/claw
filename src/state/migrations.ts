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
