#!/usr/bin/env node
/**
 * Mock claude binary for skill-detector tests.
 * Behaviour controlled via env vars:
 *   MOCK_CLAUDE_SKILL_RESPONSE  — skill name to return, or "null" (default: "null")
 *   MOCK_CLAUDE_FAIL            — if "1", exit with code 1 and no output
 */
import process from 'node:process';

const args = process.argv.slice(2);

if (args.includes('--help')) {
  process.stdout.write(
    '--output-format=stream-json --include-partial-messages --verbose --append-system-prompt\n',
  );
  process.exit(0);
}

if (process.env.MOCK_CLAUDE_FAIL === '1') {
  process.stderr.write('mock claude: simulated failure\n');
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => process.exit(1));
} else {
  const raw = process.env.MOCK_CLAUDE_SKILL_RESPONSE ?? 'null';
  const skillName = raw === 'null' ? null : raw;
  const responseText = JSON.stringify({ skill: skillName });
  const sessionId = 'mock-session-test';

  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: responseText,
      session_id: sessionId,
    }),
  ].join('\n') + '\n';

  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => {
    process.stdout.write(lines);
    process.exit(0);
  });
}
