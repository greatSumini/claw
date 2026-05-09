import type Database from 'better-sqlite3';

interface MessageQueueDbRow {
  id: number;
  channel_id: string;
  message_id: string;
  queued_at: string;
}

export interface QueuedMessage {
  id: number;
  channelId: string;
  messageId: string;
  queuedAt: string;
}

function fromRow(row: MessageQueueDbRow): QueuedMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    messageId: row.message_id,
    queuedAt: row.queued_at,
  };
}

export function enqueueMessage(
  db: Database.Database,
  channelId: string,
  messageId: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO message_queue (channel_id, message_id, queued_at)
     VALUES (?, ?, ?)`,
  ).run(channelId, messageId, new Date().toISOString());
}

export function getPendingMessages(db: Database.Database): QueuedMessage[] {
  const rows = db
    .prepare<[], MessageQueueDbRow>(
      'SELECT id, channel_id, message_id, queued_at FROM message_queue ORDER BY id ASC',
    )
    .all();
  return rows.map(fromRow);
}

export function deleteQueuedMessage(db: Database.Database, id: number): void {
  db.prepare<[number]>('DELETE FROM message_queue WHERE id = ?').run(id);
}
