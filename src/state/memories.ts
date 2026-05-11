import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

export function channelScope(channelId: string): string {
  return `channel:${channelId}`;
}

export function repoScope(repoFullName: string): string {
  return `repo:${repoFullName}`;
}

export const GLOBAL_SCOPE = 'global';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface MemoryCandidate {
  id: number;
  scope: string;
  type: string;
  key: string;
  value: string;
  score: number;
  expiresAt: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface Memory {
  id: number;
  scope: string;
  type: string;
  key: string;
  value: string;
  tags: string[]; // parsed from JSON
  score: number;
  referenceCount: number;
  lastReferencedAt: string | null;
  status: string;
  promotedFrom: number | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal DB row types
// ---------------------------------------------------------------------------

interface CandidateDbRow {
  id: number;
  scope: string;
  type: string;
  key: string;
  value: string;
  score: number;
  expires_at: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface MemoryDbRow {
  id: number;
  scope: string;
  type: string;
  key: string;
  value: string;
  tags: string;
  score: number;
  reference_count: number;
  last_referenced_at: string | null;
  status: string;
  promoted_from: number | null;
  source: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function candidateFromRow(row: CandidateDbRow): MemoryCandidate {
  return {
    id: row.id,
    scope: row.scope,
    type: row.type,
    key: row.key,
    value: row.value,
    score: row.score,
    expiresAt: row.expires_at,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memoryFromRow(row: MemoryDbRow): Memory {
  return {
    id: row.id,
    scope: row.scope,
    type: row.type,
    key: row.key,
    value: row.value,
    tags: JSON.parse(row.tags) as string[],
    score: row.score,
    referenceCount: row.reference_count,
    lastReferencedAt: row.last_referenced_at ?? null,
    status: row.status,
    promotedFrom: row.promoted_from ?? null,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Layer 1 CRUD
// ---------------------------------------------------------------------------

export function saveCandidate(
  db: Database.Database,
  opts: {
    scope: string;
    type?: string;
    key: string;
    value: string;
    source?: string;
  },
): number {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const stmt = db.prepare(`
    INSERT INTO memories_candidate (scope, type, key, value, score, expires_at, source, created_at, updated_at)
    VALUES (@scope, @type, @key, @value, 50, @expiresAt, @source, @now, @now)
    ON CONFLICT(scope, key) DO UPDATE SET
      value      = excluded.value,
      type       = excluded.type,
      source     = excluded.source,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `);

  stmt.run({
    scope: opts.scope,
    type: opts.type ?? 'general',
    key: opts.key,
    value: opts.value,
    expiresAt,
    source: opts.source ?? 'explicit',
    now,
  });

  const row = db
    .prepare<[string, string], { id: number }>(
      'SELECT id FROM memories_candidate WHERE scope = ? AND key = ?',
    )
    .get(opts.scope, opts.key);

  return row!.id;
}

export function listCandidates(db: Database.Database): MemoryCandidate[] {
  const rows = db
    .prepare<[], CandidateDbRow>(
      'SELECT id, scope, type, key, value, score, expires_at, source, created_at, updated_at FROM memories_candidate ORDER BY updated_at DESC',
    )
    .all();
  return rows.map(candidateFromRow);
}

export function updateCandidateScore(
  db: Database.Database,
  candidateId: number,
  delta: number,
  threadId?: string,
): void {
  const now = new Date().toISOString();

  db.prepare<[number, string, number]>(
    'UPDATE memories_candidate SET score = score + ?, updated_at = ? WHERE id = ?',
  ).run(delta, now, candidateId);

  db.prepare(
    `INSERT INTO memory_events (memory_id, layer, event_type, delta, thread_id, created_at)
     VALUES (@memoryId, 'candidate', 'score_update', @delta, @threadId, @now)`,
  ).run({
    memoryId: candidateId,
    delta,
    threadId: threadId ?? null,
    now,
  });
}

export function forgetCandidate(db: Database.Database, candidateId: number): void {
  db.prepare<[number]>('DELETE FROM memories_candidate WHERE id = ?').run(candidateId);
}

// ---------------------------------------------------------------------------
// Layer 2 CRUD
// ---------------------------------------------------------------------------

export function saveMemory(
  db: Database.Database,
  opts: {
    scope: string;
    type?: string;
    key: string;
    value: string;
    tags?: string[];
    score?: number;
    promotedFrom?: number;
    source?: string;
  },
): number {
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(opts.tags ?? []);

  const stmt = db.prepare(`
    INSERT INTO memories (scope, type, key, value, tags, score, promoted_from, source, created_at, updated_at)
    VALUES (@scope, @type, @key, @value, @tags, @score, @promotedFrom, @source, @now, @now)
    ON CONFLICT(scope, key) DO UPDATE SET
      value        = excluded.value,
      type         = excluded.type,
      tags         = excluded.tags,
      score        = excluded.score,
      promoted_from = excluded.promoted_from,
      source       = excluded.source,
      updated_at   = excluded.updated_at
  `);

  stmt.run({
    scope: opts.scope,
    type: opts.type ?? 'general',
    key: opts.key,
    value: opts.value,
    tags: tagsJson,
    score: opts.score ?? 50,
    promotedFrom: opts.promotedFrom ?? null,
    source: opts.source ?? 'explicit',
    now,
  });

  const row = db
    .prepare<[string, string], { id: number }>(
      'SELECT id FROM memories WHERE scope = ? AND key = ?',
    )
    .get(opts.scope, opts.key);

  return row!.id;
}

export function listMemories(db: Database.Database, status = 'active'): Memory[] {
  const rows = db
    .prepare<[string], MemoryDbRow>(
      `SELECT id, scope, type, key, value, tags, score, reference_count, last_referenced_at,
              status, promoted_from, source, created_at, updated_at
       FROM memories
       WHERE status = ?
       ORDER BY updated_at DESC`,
    )
    .all(status);
  return rows.map(memoryFromRow);
}

export function updateMemoryScore(
  db: Database.Database,
  memoryId: number,
  delta: number,
  threadId?: string,
): void {
  const now = new Date().toISOString();

  db.prepare<[number, string, number]>(
    'UPDATE memories SET score = score + ?, updated_at = ? WHERE id = ?',
  ).run(delta, now, memoryId);

  db.prepare(
    `INSERT INTO memory_events (memory_id, layer, event_type, delta, thread_id, created_at)
     VALUES (@memoryId, 'memory', 'score_update', @delta, @threadId, @now)`,
  ).run({
    memoryId,
    delta,
    threadId: threadId ?? null,
    now,
  });
}

export function archiveMemory(db: Database.Database, memoryId: number): void {
  const now = new Date().toISOString();
  db.prepare<[string, number]>("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(
    now,
    memoryId,
  );
}

// ---------------------------------------------------------------------------
// Promotion: Layer 1 → Layer 2
// ---------------------------------------------------------------------------

export function promoteCandidate(db: Database.Database, candidateId: number): number {
  const candidate = db
    .prepare<[number], CandidateDbRow>(
      'SELECT id, scope, type, key, value, score, expires_at, source, created_at, updated_at FROM memories_candidate WHERE id = ?',
    )
    .get(candidateId);

  if (!candidate) {
    throw new Error(`promoteCandidate: candidate ${candidateId} not found`);
  }

  const tags = extractKeywords(candidate.value);

  const promote = db.transaction(() => {
    const memoryId = saveMemory(db, {
      scope: candidate.scope,
      type: candidate.type,
      key: candidate.key,
      value: candidate.value,
      tags,
      score: candidate.score,
      promotedFrom: candidate.id,
      source: candidate.source,
    });

    forgetCandidate(db, candidateId);

    return memoryId;
  });

  return promote() as number;
}

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  '이', '가', '을', '를', '은', '는', '에', '의', '와', '과', '도', '로', '으로',
  'the', 'a', 'an', 'is', 'are', 'in', 'on', 'at', 'to', 'for',
]);

export function extractKeywords(text: string): string[] {
  const words = text
    .split(/[\s\p{P}]+/u)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));

  return [...new Set(words)];
}

// ---------------------------------------------------------------------------
// Relevance filtering
// ---------------------------------------------------------------------------

export function loadRelevantMemories(
  db: Database.Database,
  scopes: string[],
  message: string,
  maxCount = 5,
): Memory[] {
  if (scopes.length === 0) return [];

  const placeholders = scopes.map(() => '?').join(', ');
  const rows = db
    .prepare<string[], MemoryDbRow>(
      `SELECT id, scope, type, key, value, tags, score, reference_count, last_referenced_at,
              status, promoted_from, source, created_at, updated_at
       FROM memories
       WHERE status = 'active' AND scope IN (${placeholders})
       ORDER BY score DESC
       LIMIT 30`,
    )
    .all(...scopes);

  const memories = rows.map(memoryFromRow);
  const keywords = extractKeywords(message);

  if (keywords.length === 0) {
    return memories.slice(0, maxCount);
  }

  const scored = memories.map((mem) => {
    // "절대 기억": score >= 75는 항상 포함
    const isAbsolute = mem.score >= 75;

    const searchText = [...mem.tags, mem.value].join(' ').toLowerCase();
    const relevance = keywords.filter((kw) => searchText.includes(kw)).length;

    return { mem, relevance, isAbsolute };
  });

  const maxRelevance = Math.max(...scored.map((s) => s.relevance), 1);

  const sorted = scored
    .filter((s) => s.isAbsolute || s.relevance > 0)
    .sort((a, b) => {
      const scoreA = a.mem.score * 0.7 + (a.relevance / maxRelevance) * 30;
      const scoreB = b.mem.score * 0.7 + (b.relevance / maxRelevance) * 30;
      return scoreB - scoreA;
    });

  // Ensure absolute memories are always present; fill up to maxCount with sorted results
  const absolute = scored.filter((s) => s.isAbsolute).map((s) => s.mem);
  const absoluteIds = new Set(absolute.map((m) => m.id));
  const rest = sorted.filter((s) => !absoluteIds.has(s.mem.id)).map((s) => s.mem);

  const combined = [...absolute, ...rest];
  return combined.slice(0, maxCount);
}

// ---------------------------------------------------------------------------
// Layer 1 relevance loading (for context injection)
// ---------------------------------------------------------------------------

export function loadCandidateContext(
  db: Database.Database,
  scopes: string[],
  message: string,
  maxCount = 2,
): MemoryCandidate[] {
  if (scopes.length === 0) return [];

  const placeholders = scopes.map(() => '?').join(', ');
  const rows = db
    .prepare<string[], CandidateDbRow>(
      `SELECT id, scope, type, key, value, score, expires_at, source, created_at, updated_at
       FROM memories_candidate
       WHERE scope IN (${placeholders})
       ORDER BY score DESC
       LIMIT 20`,
    )
    .all(...scopes);

  const candidates = rows.map(candidateFromRow);
  const keywords = extractKeywords(message);

  if (keywords.length === 0) return candidates.slice(0, maxCount);

  const scored = candidates.map((c) => {
    const searchText = [c.key, c.value].join(' ').toLowerCase();
    const relevance = keywords.filter((kw) => searchText.includes(kw)).length;
    return { c, relevance };
  });

  return scored
    .filter((s) => s.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || b.c.score - a.c.score)
    .slice(0, maxCount)
    .map((s) => s.c);
}

// ---------------------------------------------------------------------------
// Discord message ↔ memory references
// ---------------------------------------------------------------------------

export function recordMemoryReferences(
  db: Database.Database,
  discordMessageId: string,
  memoryIds: Array<{ id: number; layer: 'candidate' | 'memory' }>,
  threadId?: string,
): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO memory_references (discord_message_id, memory_id, layer, thread_id, created_at)
     VALUES (@discordMessageId, @memoryId, @layer, @threadId, @now)`,
  );

  const insertAll = db.transaction(() => {
    for (const { id, layer } of memoryIds) {
      stmt.run({ discordMessageId, memoryId: id, layer, threadId: threadId ?? null, now });
    }
  });

  insertAll();
}

export interface ThreadMemoryRef {
  id: number;
  layer: 'candidate' | 'memory';
  key: string;
  value: string;
  type: string;
}

export function getMemoriesForThread(
  db: Database.Database,
  threadId: string,
): ThreadMemoryRef[] {
  const layer2 = db
    .prepare<[string], ThreadMemoryRef>(
      `SELECT DISTINCT mr.memory_id AS id, 'memory' AS layer, m.key, m.value, m.type
       FROM memory_references mr
       JOIN memories m ON m.id = mr.memory_id
       WHERE mr.thread_id = ?`,
    )
    .all(threadId);

  const layer1 = db
    .prepare<[string], ThreadMemoryRef>(
      `SELECT DISTINCT mr.memory_id AS id, 'candidate' AS layer, mc.key, mc.value, mc.type
       FROM memory_references mr
       JOIN memories_candidate mc ON mc.id = mr.memory_id
       WHERE mr.thread_id = ?`,
    )
    .all(threadId);

  return [...layer2, ...layer1];
}

/** Increment reference_count and update last_referenced_at for Layer 2 memories that were injected. */
export function markMemoriesReferenced(db: Database.Database, memoryIds: number[]): void {
  if (memoryIds.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare<[string, number]>(
    'UPDATE memories SET reference_count = reference_count + 1, last_referenced_at = ? WHERE id = ?',
  );
  const update = db.transaction(() => {
    for (const id of memoryIds) {
      stmt.run(now, id);
    }
  });
  update();
}

export function getMemoriesForMessage(
  db: Database.Database,
  discordMessageId: string,
): Array<{ memoryId: number; layer: string }> {
  const rows = db
    .prepare<[string], { memory_id: number; layer: string }>(
      'SELECT memory_id, layer FROM memory_references WHERE discord_message_id = ?',
    )
    .all(discordMessageId);

  return rows.map((r) => ({ memoryId: r.memory_id, layer: r.layer }));
}
