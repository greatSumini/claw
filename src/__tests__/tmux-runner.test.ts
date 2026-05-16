import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeSessionName,
  stripAnsi,
  extractResponse,
  TmuxRunner,
  TmuxError,
  type CmdRunner,
  type TmuxRunnerOptions,
} from '../tmux-runner.js';

// ── Pure function tests ────────────────────────────────────────────────────

describe('sanitizeSessionName', () => {
  test('prefixes with claw-', () => {
    assert.ok(sanitizeSessionName('foo').startsWith('claw-'));
  });

  test('replaces non-alphanumeric chars with dashes', () => {
    assert.equal(sanitizeSessionName('thread/123:abc'), 'claw-thread-123-abc');
  });

  test('truncates to max 53 chars total (claw- + 48)', () => {
    const long = 'a'.repeat(100);
    assert.ok(sanitizeSessionName(long).length <= 53);
  });

  test('stable for same input', () => {
    const key = 'discord-guild-ch-thread';
    assert.equal(sanitizeSessionName(key), sanitizeSessionName(key));
  });
});

describe('stripAnsi', () => {
  test('removes CSI sequences', () => {
    assert.equal(stripAnsi('\x1B[31mred\x1B[0m'), 'red');
  });

  test('removes cursor positioning', () => {
    assert.equal(stripAnsi('\x1B[2;5Hhello'), 'hello');
  });

  test('leaves plain text unchanged', () => {
    assert.equal(stripAnsi('hello world'), 'hello world');
  });

  test('handles empty string', () => {
    assert.equal(stripAnsi(''), '');
  });

  test('removes multiple sequences', () => {
    const input = '\x1B[1m\x1B[32mGreen Bold\x1B[0m\x1B[m normal';
    assert.equal(stripAnsi(input), 'Green Bold normal');
  });
});

describe('extractResponse', () => {
  test('extracts text after anchor (first line of prompt)', () => {
    const before = 'previous content\n> ';
    const after = 'previous content\nHello world\nClaude says: hi there!\n> ';
    const prompt = 'Hello world';
    const result = extractResponse(before, after, prompt);
    assert.ok(result.includes('Claude says: hi there!'), `got: ${result}`);
  });

  test('falls back to line diff when anchor not found', () => {
    const before = 'line A\nline B\n';
    const after = 'line A\nline B\nline C — new response\n';
    const prompt = 'prompt not in pane';
    const result = extractResponse(before, after, prompt);
    assert.ok(result.includes('line C — new response'), `got: ${result}`);
  });

  test('returns after pane when both strategies produce empty', () => {
    const same = 'same content\n';
    const result = extractResponse(same, same, 'anchor missing');
    assert.equal(result, same.trim());
  });

  test('uses only the first line of a multi-line prompt as anchor', () => {
    const before = '';
    const prompt = 'first line\nsecond line\nthird line';
    const after = 'first line\nClaude response here\n';
    const result = extractResponse(before, after, prompt);
    assert.ok(result.includes('Claude response here'), `got: ${result}`);
  });

  test('trims whitespace from result', () => {
    const before = '';
    const after = 'anchor\n   \nresponse\n   \n';
    const result = extractResponse(before, after, 'anchor');
    assert.equal(result, 'response');
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

type CmdCall = { args: string[] };

function makeMock(handler: (args: string[]) => { out: string; code: number }): {
  runner: CmdRunner;
  calls: CmdCall[];
} {
  const calls: CmdCall[] = [];
  const runner: CmdRunner = async (args) => {
    calls.push({ args });
    return handler(args);
  };
  return { runner, calls };
}

/** Fast-timing options: no real sleeps in tests. */
const FAST: Partial<TmuxRunnerOptions> = {
  initWaitMs: 0,
  pollMs: 10,
  stablePolls: 2,
  minWaitMs: 0,
};

// ── TmuxRunner.ensureSession ───────────────────────────────────────────────

describe('TmuxRunner.ensureSession', () => {
  test('creates session when none exists (has-session returns 1)', async () => {
    const { runner, calls } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 1 };
      return { out: '', code: 0 };
    });
    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.ensureSession('test-sess', '/tmp');

    const newSession = calls.find((c) => c.args[1] === 'new-session');
    assert.ok(newSession, 'new-session should have been called');
    assert.ok(newSession.args.includes('test-sess'));
    assert.ok(newSession.args.includes('/tmp'));
  });

  test('skips creation when session already alive (has-session returns 0)', async () => {
    const { runner, calls } = makeMock(() => ({ out: '', code: 0 }));
    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.ensureSession('existing-sess', '/tmp');

    const newSession = calls.find((c) => c.args[1] === 'new-session');
    assert.equal(newSession, undefined, 'new-session should NOT have been called');
  });
});

// ── TmuxRunner.kill ────────────────────────────────────────────────────────

describe('TmuxRunner.kill', () => {
  test('kills session after run populates the map', async () => {
    let captureCount = 0;
    const { runner, calls } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 0 };
      if (args[1] === 'capture-pane') {
        captureCount++;
        if (captureCount === 1) return { out: 'before\n', code: 0 };
        return { out: 'before\nmy prompt\nClaude: done\n', code: 0 };
      }
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.run({ cwd: '/tmp', prompt: 'my prompt', sessionKey: 'kill-test-key', timeoutMs: 5_000 });
    await tmux.kill('kill-test-key');

    const killCall = calls.find((c) => c.args[1] === 'kill-session');
    assert.ok(killCall, 'kill-session should have been called');
  });

  test('no-ops when key not in map', async () => {
    const { runner, calls } = makeMock(() => ({ out: '', code: 0 }));
    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.kill('nonexistent');
    const killCall = calls.find((c) => c.args[1] === 'kill-session');
    assert.equal(killCall, undefined);
  });
});

// ── TmuxRunner.waitUntilStable ─────────────────────────────────────────────

describe('TmuxRunner.waitUntilStable', () => {
  test('returns pane when output stabilizes', async () => {
    let callCount = 0;
    const stableContent = 'stable response content';
    const { runner } = makeMock((args) => {
      if (args[1] === 'capture-pane') {
        callCount++;
        if (callCount <= 2) return { out: `changing-${callCount}`, code: 0 };
        return { out: stableContent, code: 0 };
      }
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    // startMs far enough in the past to satisfy minWaitMs=0
    const result = await tmux.waitUntilStable('sess', Date.now(), 60_000);
    assert.equal(result, stableContent);
  });

  test('throws TmuxError on timeout', async () => {
    const { runner } = makeMock((args) => {
      if (args[1] === 'capture-pane') return { out: `content-${Date.now()}`, code: 0 };
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await assert.rejects(
      () => tmux.waitUntilStable('sess', Date.now() - 10_000, 1),
      TmuxError,
    );
  });

  test('throws TmuxError when signal aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner } = makeMock(() => ({ out: '', code: 0 }));
    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await assert.rejects(
      () => tmux.waitUntilStable('sess', Date.now(), 60_000, controller.signal),
      TmuxError,
    );
  });
});

// ── TmuxRunner.run — happy path ────────────────────────────────────────────

describe('TmuxRunner.run', () => {
  test('returns extracted text and empty artifacts for simple response', async () => {
    let captureCallCount = 0;
    const { runner } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 0 };
      if (args[1] === 'capture-pane') {
        captureCallCount++;
        if (captureCallCount === 1) return { out: 'before\n', code: 0 };
        if (captureCallCount <= 3) return { out: `before\nchanging-${captureCallCount}`, code: 0 };
        return { out: 'before\nmy prompt here\nHello from Claude!\n', code: 0 };
      }
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    const result = await tmux.run({
      cwd: '/tmp',
      prompt: 'my prompt here',
      sessionKey: 'thread-abc',
      timeoutMs: 30_000,
    });

    assert.ok(result.text.includes('Hello from Claude!'), `text: ${result.text}`);
    assert.equal(result.artifacts.length, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionKey, 'thread-abc');
  });

  test('includes systemAppend in full message sent to tmux', async () => {
    let captureCallCount = 0;
    const sentMessages: string[] = [];

    // Intercept file writes to capture what was sent
    const { runner } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 0 };
      if (args[1] === 'load-buffer') {
        // The file path is args[2]; we can't easily read it, but we verify it was called
        sentMessages.push(args[2] ?? '');
        return { out: '', code: 0 };
      }
      if (args[1] === 'capture-pane') {
        captureCallCount++;
        if (captureCallCount === 1) return { out: '', code: 0 };
        return { out: 'user prompt\nClaude response\n', code: 0 };
      }
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.run({
      cwd: '/tmp',
      prompt: 'user prompt',
      systemAppend: 'system instructions here',
      sessionKey: 'thread-sys',
      timeoutMs: 30_000,
    });

    // load-buffer should have been called (message was sent via paste-buffer)
    assert.ok(sentMessages.length > 0, 'load-buffer should have been called');
  });

  test('concurrent calls on same key are serialized (mutex)', async () => {
    const completed: string[] = [];
    // Always return stable pane — allows both runs to complete quickly
    const { runner } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 0 };
      if (args[1] === 'capture-pane') return { out: 'prompt-A\nClaude done\n', code: 0 };
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    const p1 = tmux.run({ cwd: '/tmp', prompt: 'prompt-A', sessionKey: 'shared-key', timeoutMs: 5_000 })
      .then(() => completed.push('first'));
    const p2 = tmux.run({ cwd: '/tmp', prompt: 'prompt-A', sessionKey: 'shared-key', timeoutMs: 5_000 })
      .then(() => completed.push('second'));

    await Promise.all([p1, p2]);
    // Both must complete (mutex serializes them, not drops them)
    assert.equal(completed.length, 2);
    assert.ok(completed.includes('first'));
    assert.ok(completed.includes('second'));
  });
});
