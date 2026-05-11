/**
 * Hybrid memory retrieval: 60% base score + 20% keyword relevance + 20% cosine similarity.
 * Falls back to keyword-only (loadRelevantMemories) if embeddings are unavailable.
 */
import type Database from 'better-sqlite3';
import { extractKeywords, loadRelevantMemories, type Memory } from './memories.js';
import { log } from '../log.js';

interface MemoryRowWithEmb {
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
  embedding: string | null;
}

function rowToMemory(row: MemoryRowWithEmb): Memory {
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

export async function loadRelevantMemoriesHybrid(
  db: Database.Database,
  scopes: string[],
  message: string,
  maxCount = 5,
): Promise<Memory[]> {
  if (scopes.length === 0) return [];

  const placeholders = scopes.map(() => '?').join(', ');
  const rows = db
    .prepare<string[], MemoryRowWithEmb>(
      `SELECT id, scope, type, key, value, tags, score, reference_count, last_referenced_at,
              status, promoted_from, source, created_at, updated_at, embedding
       FROM memories
       WHERE status = 'active' AND scope IN (${placeholders})
       ORDER BY score DESC
       LIMIT 30`,
    )
    .all(...scopes);

  if (rows.length === 0) return [];

  const keywords = extractKeywords(message);

  // Try to get a query embedding; gracefully fall back if model isn't ready.
  let queryEmb: number[] | null = null;
  let cosineSimFn: ((a: number[], b: number[]) => number) | null = null;
  try {
    const embModule = await import('./embeddings.js');
    queryEmb = await embModule.embedText(message, true);
    cosineSimFn = embModule.cosineSimilarity;
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'hybrid-search: embedding unavailable, keyword-only');
    return loadRelevantMemories(db, scopes, message, maxCount);
  }

  const scored = rows.map((row) => {
    const mem = rowToMemory(row);
    const searchText = [...mem.tags, mem.value].join(' ').toLowerCase();
    const keywordRelevance =
      keywords.length > 0 ? keywords.filter((kw) => searchText.includes(kw)).length : 0;

    let cosineScore = 0;
    if (queryEmb && cosineSimFn && row.embedding) {
      try {
        const memEmb = JSON.parse(row.embedding) as number[];
        cosineScore = cosineSimFn(queryEmb, memEmb);
      } catch {
        // malformed embedding, leave cosineScore = 0
      }
    }

    return { mem, keywordRelevance, cosineScore };
  });

  // If no signal at all, return top by base score.
  const anySignal = scored.some((s) => s.keywordRelevance > 0 || s.cosineScore > 0.35);
  if (!anySignal) return rows.slice(0, maxCount).map(rowToMemory);

  const maxKeyword = Math.max(...scored.map((s) => s.keywordRelevance), 1);

  return scored
    .filter((s) => s.keywordRelevance > 0 || s.cosineScore > 0.35)
    .sort((a, b) => {
      const sA = a.mem.score * 0.6 + (a.keywordRelevance / maxKeyword) * 20 + a.cosineScore * 20;
      const sB = b.mem.score * 0.6 + (b.keywordRelevance / maxKeyword) * 20 + b.cosineScore * 20;
      return sB - sA;
    })
    .slice(0, maxCount)
    .map((s) => s.mem);
}
