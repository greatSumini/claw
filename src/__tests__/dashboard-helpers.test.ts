import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  fmtTs,
  startOfTodayKstIso,
} from '../dashboard/routes.js';

describe('dashboard: escapeHtml', () => {
  test('escapes &', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
  });

  test('escapes < and >', () => {
    assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
  });

  test('escapes double quotes', () => {
    assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  });

  test('escapes single quotes', () => {
    assert.equal(escapeHtml("it's"), 'it&#39;s');
  });

  test('escapes mixed input', () => {
    assert.equal(
      escapeHtml(`hello <world> & "friends" 'too'`),
      `hello &lt;world&gt; &amp; &quot;friends&quot; &#39;too&#39;`,
    );
  });

  test('escapes & before other entities (no double-encoding of &amp;)', () => {
    // Verify: a literal '&amp;' becomes '&amp;amp;'.
    assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  });

  test('passes through plain text untouched', () => {
    assert.equal(escapeHtml('plain text 123'), 'plain text 123');
  });
});

describe('dashboard: fmtTs', () => {
  test('null / undefined → em dash placeholder', () => {
    assert.equal(fmtTs(null), '—');
    assert.equal(fmtTs(undefined), '—');
    assert.equal(fmtTs(''), '—');
  });

  test('formats a known UTC timestamp into KST YYYY-MM-DD HH:mm:ss', () => {
    // 2025-01-15T00:00:00Z = 2025-01-15 09:00:00 KST
    const out = fmtTs('2025-01-15T00:00:00Z');
    assert.equal(out, '2025-01-15 09:00:00');
  });

  test('invalid date string returned as-is', () => {
    assert.equal(fmtTs('not-a-date'), 'not-a-date');
  });
});

describe('dashboard: startOfTodayKstIso', () => {
  test('returns a valid ISO string', () => {
    const iso = startOfTodayKstIso();
    const parsed = new Date(iso);
    assert.ok(!Number.isNaN(parsed.getTime()), `not a valid date: ${iso}`);
    // ISO format with Z (UTC) suffix.
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  });

  test('corresponds to KST midnight (00:00 KST = 15:00 UTC of previous day)', () => {
    const iso = startOfTodayKstIso();
    const date = new Date(iso);
    // KST midnight expressed as UTC must be 15:00:00.
    assert.equal(date.getUTCHours(), 15);
    assert.equal(date.getUTCMinutes(), 0);
    assert.equal(date.getUTCSeconds(), 0);
  });

  test('result is in the past relative to now (today started before now)', () => {
    const iso = startOfTodayKstIso();
    const t = new Date(iso).getTime();
    assert.ok(t <= Date.now(), 'startOfToday should be ≤ now');
    // And not more than 24h before now.
    assert.ok(Date.now() - t <= 24 * 60 * 60 * 1000 + 60_000);
  });
});
