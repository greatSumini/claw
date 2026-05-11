import type Database from 'better-sqlite3';
import { log } from '../log.js';

const MODEL_ID = 'Xenova/multilingual-e5-small';

// Lazy-initialized pipeline — model downloads ~117MB on first use.
type EmbeddingPipeline = (
  text: string | string[],
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let pipelinePromise: Promise<EmbeddingPipeline> | null = null;

async function getPipeline(): Promise<EmbeddingPipeline> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    // Dynamic import keeps startup fast when embeddings aren't used immediately.
    const { pipeline } = await import('@huggingface/transformers');
    log.info({ model: MODEL_ID }, 'embeddings: loading model (first run downloads ~117MB)');
    const pipe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' });
    log.info({ model: MODEL_ID }, 'embeddings: model ready');
    return pipe as unknown as EmbeddingPipeline;
  })().catch((err: Error) => {
    pipelinePromise = null; // allow retry
    throw err;
  });
  return pipelinePromise;
}

/**
 * Generate a 384-dim embedding for `text`.
 * Prefix "query: " for queries, "passage: " for documents (e5 instruction tuning).
 */
export async function embedText(text: string, isQuery = false): Promise<number[]> {
  const pipe = await getPipeline();
  const prefixed = isQuery ? `query: ${text}` : `passage: ${text}`;
  const output = await pipe(prefixed, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function updateMemoryEmbedding(
  db: Database.Database,
  memoryId: number,
  embedding: number[],
): void {
  db.prepare<[string, number]>('UPDATE memories SET embedding = ? WHERE id = ?').run(
    JSON.stringify(embedding),
    memoryId,
  );
}

/** Embed active memories that don't have an embedding yet, in small batches. */
export async function embedPendingMemories(
  db: Database.Database,
  batchSize = 5,
): Promise<number> {
  const rows = db
    .prepare<[number], { id: number; value: string }>(
      `SELECT id, value FROM memories
       WHERE status = 'active' AND (embedding IS NULL OR embedding = '')
       LIMIT ?`,
    )
    .all(batchSize);

  if (rows.length === 0) return 0;

  let count = 0;
  for (const row of rows) {
    try {
      const emb = await embedText(row.value);
      updateMemoryEmbedding(db, row.id, emb);
      count++;
    } catch (err) {
      log.warn({ err: (err as Error).message, id: row.id }, 'embeddings: failed for memory');
    }
  }
  log.info({ count }, 'embeddings: pending memories embedded');
  return count;
}
