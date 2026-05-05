import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractPlainText } from '../adapters/gmail.js';

const b64url = (s: string): string =>
  Buffer.from(s, 'utf-8').toString('base64url');

describe('gmail: extractPlainText', () => {
  test('plain text part decodes correctly', () => {
    const out = extractPlainText({
      mimeType: 'text/plain',
      body: { data: b64url('hello world') },
    });
    assert.equal(out, 'hello world');
  });

  test('multipart prefers plain over html', () => {
    const out = extractPlainText({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<p>html version</p>') } },
        { mimeType: 'text/plain', body: { data: b64url('plain version') } },
      ],
    });
    assert.equal(out, 'plain version');
  });

  test('html-only falls back to stripped text', () => {
    const out = extractPlainText({
      mimeType: 'text/html',
      body: {
        data: b64url('<p>only html</p>'),
      },
    });
    assert.equal(out, 'only html');
  });

  test('html with style/script/entities is cleaned', () => {
    const html =
      '<style>x{color:red}</style>' +
      '<script>alert(1)</script>' +
      '<p>hello &amp; goodbye</p><br><p>line two</p>';
    const out = extractPlainText({
      mimeType: 'text/html',
      body: { data: b64url(html) },
    });
    assert.ok(out.includes('hello & goodbye'));
    assert.ok(out.includes('line two'));
    assert.ok(!out.includes('<p>'));
    assert.ok(!out.toLowerCase().includes('<script'));
    assert.ok(!out.toLowerCase().includes('<style'));
  });

  test('null / undefined / empty payload → empty string', () => {
    assert.equal(extractPlainText(undefined), '');
    assert.equal(extractPlainText(null), '');
    assert.equal(extractPlainText({}), '');
  });

  test('nested multipart walks recursively', () => {
    const out = extractPlainText({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/html', body: { data: b64url('<p>html</p>') } },
            {
              mimeType: 'text/plain',
              body: { data: b64url('nested plain text') },
            },
          ],
        },
        {
          mimeType: 'application/pdf',
          body: { attachmentId: 'a-1' },
        },
      ],
    });
    assert.equal(out, 'nested plain text');
  });

  test('truncates long bodies with marker', () => {
    const big = 'A'.repeat(5000);
    const out = extractPlainText({
      mimeType: 'text/plain',
      body: { data: b64url(big) },
    });
    assert.ok(out.includes('…(이하 생략)'));
    assert.ok(out.length < big.length);
    // The truncation point should keep ~4000 chars of content.
    assert.ok(out.startsWith('A'.repeat(100)));
  });

  test('multiple plain-text parts joined with newline', () => {
    const out = extractPlainText({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('part one') } },
        { mimeType: 'text/plain', body: { data: b64url('part two') } },
      ],
    });
    assert.ok(out.includes('part one'));
    assert.ok(out.includes('part two'));
  });
});
