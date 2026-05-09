import type Database from 'better-sqlite3';
import { listEventsByThread } from '../state/events.js';

/**
 * Build a human-readable transcript from a thread's event history.
 * Only includes inbound user messages and outbound claw responses.
 * Each entry is truncated to 300 chars (events table stores up to 200 anyway).
 */
export function buildConversationTranscript(
  db: Database.Database,
  threadId: string,
): string {
  const events = listEventsByThread(db, threadId, 100);
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'discord.message.in' && ev.type !== 'discord.message.out') continue;
    const who = ev.type === 'discord.message.in' ? '사용자' : 'claw';
    const ts = ev.ts.slice(0, 19).replace('T', ' ');
    const text = ev.summary.length > 300 ? ev.summary.slice(0, 300) + '…' : ev.summary;
    lines.push(`[${ts}] ${who}: ${text}`);
  }
  return lines.join('\n') || '(대화 기록 없음)';
}

/**
 * Build the prompt sent to Claude for auto-analysis.
 * Claude runs in the claw repo CWD so it can inspect the codebase.
 * `repo` is the GitHub fullName of the repo that was worked on (e.g. "vibemafiaclub/context-hub").
 */
export function buildAnalysisPrompt(
  threadId: string,
  transcript: string,
  repo: string,
): string {
  return [
    `다음은 claw Discord 에이전트가 처리한 작업 대화입니다 (thread: ${threadId}, repo: ${repo}).`,
    '',
    '## 대화 기록',
    transcript,
    '',
    '---',
    '',
    `이 대화(repo: ${repo})를 분석해서 시스템 개선 포인트를 찾아줘:`,
    '',
    '1. **반복 패턴**: 사용자가 같은 종류의 지시를 여러 번 했거나, Claude가 알아서 처리했어야 할 것을 물어본 경우',
    `2. **개선 제안** (3개 이하): ${repo} 또는 claw 코드/프롬프트에서 구체적으로 개선할 수 있는 항목과 구현 방법`,
    '3. **우선순위**: 임팩트 순',
    '',
    '분석 결과(반복 패턴, 각 개선 제안의 내용·구현 방법·우선순위)를 항목별로 **상세히** 제시해라. 내용 생략 금지.',
  ].join('\n');
}
