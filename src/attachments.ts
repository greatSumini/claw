import { createWriteStream, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { log } from './log.js';

/**
 * Downloads Discord attachment URLs to a timestamped temp directory.
 * Returns the list of saved absolute file paths.
 * Skips files that fail to download (logs + continues).
 */
export async function downloadAttachments(
  attachments: Array<{ name: string; url: string }>,
): Promise<string[]> {
  if (attachments.length === 0) return [];

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destDir = join(tmpdir(), 'claw-attachments', stamp);
  mkdirSync(destDir, { recursive: true });

  const saved: string[] = [];

  for (const { name, url } of attachments) {
    // Sanitize filename — strip path components, keep extension.
    const safeName = name.replace(/[/\\]/g, '_') || 'attachment';
    const dest = join(destDir, safeName);

    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        log.warn({ url, status: res.status }, 'attachment download failed');
        continue;
      }
      const writeStream = createWriteStream(dest);
      await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), writeStream);
      saved.push(dest);
      log.info({ dest, name }, 'attachment saved');
    } catch (err) {
      log.warn({ url, err: (err as Error).message }, 'attachment download error');
    }
  }

  return saved;
}

/**
 * Formats saved attachment paths into a note to append to the user message.
 */
export function attachmentNote(paths: string[]): string {
  if (paths.length === 0) return '';
  const list = paths.map((p) => `- ${p}`).join('\n');
  return `\n\n[첨부파일 저장됨 — 아래 경로에서 직접 읽을 수 있습니다]\n${list}`;
}
