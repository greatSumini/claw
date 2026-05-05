import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { splitMessage, makeThreadTitle, truncate } from '../adapters/discord.js';

const THREAD_NAME_MAX = 90;

describe('discord: splitMessage', () => {
  test('empty string returns single empty chunk', () => {
    const out = splitMessage('', 1900);
    assert.equal(out.length, 1);
    assert.equal(out[0], '');
  });

  test('short text → single chunk, no prefix', () => {
    const out = splitMessage('hello world', 1900);
    assert.equal(out.length, 1);
    assert.equal(out[0], 'hello world');
    assert.ok(!out[0]!.startsWith('[1/'));
  });

  test('long text → splits into multiple chunks with [i/N] prefix', () => {
    const long = 'x'.repeat(5000);
    const out = splitMessage(long, 1900);
    assert.ok(out.length >= 3, `expected ≥ 3 chunks, got ${out.length}`);
    for (const [i, chunk] of out.entries()) {
      assert.ok(
        chunk.length <= 1900,
        `chunk ${i} exceeds maxLen: ${chunk.length}`,
      );
      assert.ok(
        chunk.startsWith(`[${i + 1}/${out.length}]\n`),
        `chunk ${i} missing/incorrect prefix: head=${chunk.slice(0, 16)}`,
      );
    }
  });

  test('paragraph-break splitting preferred', () => {
    // 5 paragraphs each ~800 chars apart, separated by `\n\n`.
    const para = (`para`.padEnd(800, 'x') + '\n\n').repeat(5);
    const out = splitMessage(para, 1900);
    assert.ok(out.length >= 2);
    for (const chunk of out) {
      assert.ok(chunk.length <= 1900);
    }
  });

  test('code fences balanced across chunks', () => {
    // Make a long code block to force a split. Each chunk should have an even
    // number of triple-backtick fences.
    const code = '```ts\n' + '// line\n'.repeat(400) + '```';
    const out = splitMessage(code, 1900);
    assert.ok(out.length >= 2, `expected split, got ${out.length} chunk(s)`);
    for (const [i, chunk] of out.entries()) {
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      assert.equal(
        fenceCount % 2,
        0,
        `chunk ${i} has unbalanced fences: ${fenceCount}`,
      );
    }
    // First chunk should preserve the language tag on its opening fence.
    assert.ok(out[0]!.includes('```ts'));
  });

  test('hard-cut single very long line with no separators', () => {
    const line = 'a'.repeat(5000);
    const out = splitMessage(line, 1900);
    assert.ok(out.length >= 2);
    for (const chunk of out) {
      assert.ok(chunk.length <= 1900);
    }
  });

  test('rejects non-string text', () => {
    assert.throws(() =>
      splitMessage(undefined as unknown as string, 1900),
    );
  });

  test('rejects non-positive maxLen', () => {
    assert.throws(() => splitMessage('hello', 0));
    assert.throws(() => splitMessage('hello', -1));
  });
});

describe('discord: makeThreadTitle', () => {
  test('empty input → "untitled"', () => {
    assert.equal(makeThreadTitle(''), 'untitled');
    assert.equal(makeThreadTitle('   '), 'untitled');
  });

  test('strips leading user/role mentions', () => {
    assert.equal(makeThreadTitle('<@123> hello'), 'hello');
    assert.equal(makeThreadTitle('<@!123> hello'), 'hello');
    assert.equal(makeThreadTitle('<@&123> hello'), 'hello');
    assert.equal(makeThreadTitle('<@1> <@2> hello'), 'hello');
  });

  test('strips leading punctuation', () => {
    assert.equal(makeThreadTitle('  !!! hi there'), 'hi there');
    assert.equal(makeThreadTitle('???hello'), 'hello');
  });

  test('takes first sentence-ish chunk when reasonably short', () => {
    assert.equal(
      makeThreadTitle('<@1234> hello world. extra stuff after.'),
      'hello world.',
    );
  });

  test('collapses newlines to single space', () => {
    const t = makeThreadTitle('first line\nsecond line');
    assert.ok(!t.includes('\n'));
    assert.equal(t, 'first line second line');
  });

  test('long input truncated with ellipsis at THREAD_NAME_MAX', () => {
    const long = 'a'.repeat(200);
    const t = makeThreadTitle(long);
    assert.ok(t.length <= THREAD_NAME_MAX, `length=${t.length}`);
    assert.ok(t.endsWith('…'));
  });
});

describe('discord: truncate', () => {
  test('shorter than max → unchanged', () => {
    assert.equal(truncate('abc', 10), 'abc');
  });

  test('exactly max → unchanged', () => {
    assert.equal(truncate('abcde', 5), 'abcde');
  });

  test('longer than max → ellipsis appended; total length ≤ max', () => {
    const out = truncate('abcdefghij', 5);
    assert.ok(out.length <= 5);
    assert.ok(out.endsWith('…'));
    assert.equal(out, 'abcd…');
  });

  test('max ≤ 0 → empty string', () => {
    assert.equal(truncate('hello', 0), '');
    assert.equal(truncate('hello', -3), '');
  });

  test('non-string → empty string', () => {
    assert.equal(truncate(undefined as unknown as string, 5), '');
    assert.equal(truncate(null as unknown as string, 5), '');
    assert.equal(truncate(123 as unknown as string, 5), '');
  });

  test('empty string → empty string', () => {
    assert.equal(truncate('', 5), '');
  });
});
