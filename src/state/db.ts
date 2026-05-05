import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

const instances = new Map<string, Database.Database>();

export function getDb(dbFile: string): Database.Database {
  if (!dbFile || typeof dbFile !== 'string') {
    throw new Error('getDb: dbFile must be a non-empty string');
  }

  const cached = instances.get(dbFile);
  if (cached && cached.open) {
    return cached;
  }

  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);

  instances.set(dbFile, db);
  return db;
}

export function closeDb(dbFile?: string): void {
  if (dbFile) {
    const db = instances.get(dbFile);
    if (db && db.open) {
      db.close();
    }
    instances.delete(dbFile);
    return;
  }

  for (const [path, db] of instances.entries()) {
    if (db.open) db.close();
    instances.delete(path);
  }
}
