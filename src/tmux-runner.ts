import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { type Artifact, extractArtifacts } from './artifact.js';
import { log } from './log.js';

export interface TmuxRunOptions {
  cwd: string;
  prompt: string;
  systemAppend?: string;
  /** Unique key for this session — typically the Discord threadKey. */
  sessionKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TmuxRunResult {
  text: string;
  sessionKey: string;
  durationMs: number;
  exitCode: number;
  artifacts: Artifact[];
}

export class TmuxError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TmuxError';
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function getClaudeBin(): string {
  return process.env['CLAUDE_BIN'] ?? 'claude';
}

/** tmux session names: only alphanumeric, dash, underscore. */
function sanitizeName(key: string): string {
  return `claw-${key.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 48)}`;
}

async function runCmd(args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(args[0]!, args.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    proc.once('close', (code) => resolve({ out, code: code ?? 1 }));
    proc.once('error', () => resolve({ out, code: 1 }));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip ANSI escape codes from terminal output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B[()][0-9A-Z]/g, '');
}

// ── Mutex ──────────────────────────────────────────────────────────────────

class Mutex {
  private queue: Array<() => void> = [];
  private held = false;

  acquire(): Promise<() => void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.held = false;
  }
}

// ── constants ──────────────────────────────────────────────────────────────

/** Time to wait after spawning Claude for it to finish initializing. */
const INIT_WAIT_MS = 8_000;
/** How often to poll pane content while waiting for a response. */
const POLL_MS = 800;
/** Number of consecutive identical polls required to consider output stable. */
const STABLE_POLLS = 3;
/** Minimum elapsed time before we accept a stable reading (avoids false early termination). */
const MIN_WAIT_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 600_000;

// ── TmuxRunner ─────────────────────────────────────────────────────────────

export class TmuxRunner {
  private sessions = new Map<string, { name: string; mutex: Mutex }>();

  private getSession(key: string): { name: string; mutex: Mutex } {
    let s = this.sessions.get(key);
    if (!s) {
      s = { name: sanitizeName(key), mutex: new Mutex() };
      this.sessions.set(key, s);
    }
    return s;
  }

  /**
   * Ensure a tmux session running `claude` exists for the given session name.
   * No-ops if the session is already alive.
   */
  private async ensureSession(name: string, cwd: string): Promise<void> {
    const { code } = await runCmd(['tmux', 'has-session', '-t', name]);
    if (code === 0) return;

    await runCmd(['tmux', 'new-session', '-d', '-s', name, '-c', cwd, getClaudeBin()]);
    log.info({ name, cwd }, 'tmux: new session started');
    // Wait for Claude's TUI to fully initialize before we interact with it.
    await sleep(INIT_WAIT_MS);
  }

  /** Capture the full scrollback + visible pane content as plain text. */
  private async capturePane(name: string): Promise<string> {
    // -J joins wrapped lines; -S -3000 includes up to 3000 lines of scrollback.
    const { out } = await runCmd(['tmux', 'capture-pane', '-t', name, '-p', '-J', '-S', '-3000']);
    return stripAnsi(out);
  }

  /**
   * Send a (potentially multi-line) message to the tmux session using the
   * paste-buffer mechanism, then press Enter to submit.
   */
  private async sendMessage(name: string, message: string): Promise<void> {
    const tmpPath = path.join(os.tmpdir(), `claw-tmux-${Date.now()}.txt`);
    await fs.writeFile(tmpPath, message, 'utf8');
    try {
      await runCmd(['tmux', 'load-buffer', tmpPath]);
      await runCmd(['tmux', 'paste-buffer', '-t', name]);
      // Brief pause so the TUI can register the pasted content before Enter.
      await sleep(200);
      await runCmd(['tmux', 'send-keys', '-t', name, '', 'Enter']);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  /**
   * Poll the pane until output has been stable for STABLE_POLLS consecutive
   * reads (each POLL_MS apart), with a minimum elapsed time of MIN_WAIT_MS.
   */
  private async waitUntilStable(
    name: string,
    startMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    let prev = '';
    let stableCount = 0;

    while (true) {
      if (signal?.aborted) throw new TmuxError('aborted');
      const elapsed = Date.now() - startMs;
      if (elapsed > timeoutMs) throw new TmuxError(`timeout after ${timeoutMs}ms`);

      await sleep(POLL_MS);

      const pane = await this.capturePane(name);
      if (pane === prev && elapsed >= MIN_WAIT_MS) {
        stableCount++;
        if (stableCount >= STABLE_POLLS) return pane;
      } else {
        stableCount = 0;
        prev = pane;
      }
    }
  }

  async run(opts: TmuxRunOptions): Promise<TmuxRunResult> {
    const start = Date.now();
    const { cwd, prompt, systemAppend, sessionKey, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

    const sess = this.getSession(sessionKey);
    const release = await sess.mutex.acquire();

    try {
      await this.ensureSession(sess.name, cwd);

      // Prepend systemAppend instructions to the prompt so Claude sees them
      // as part of the user turn (consistent with --print mode behaviour).
      const fullMsg = systemAppend ? `${prompt}\n\n---\n${systemAppend}` : prompt;

      const before = await this.capturePane(sess.name);
      await this.sendMessage(sess.name, fullMsg);
      const after = await this.waitUntilStable(sess.name, start, timeoutMs, signal);

      const raw = extractResponse(before, after, prompt);
      const durationMs = Date.now() - start;
      const { text, artifacts } = extractArtifacts(raw);

      log.info({ sessionKey, durationMs, textLen: text.length }, 'tmux run ok');
      return { text, sessionKey, durationMs, exitCode: 0, artifacts };
    } finally {
      release();
    }
  }

  async kill(key: string): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return;
    await runCmd(['tmux', 'kill-session', '-t', s.name]);
    this.sessions.delete(key);
    log.info({ key, name: s.name }, 'tmux: session killed');
  }

  async killAll(): Promise<void> {
    for (const key of [...this.sessions.keys()]) {
      await this.kill(key);
    }
  }
}

/**
 * Extract the assistant's response from the pane snapshot taken after the
 * message was sent.
 *
 * Strategy: find the first line of the user's prompt in the `after` snapshot
 * (as a visual anchor for where our turn starts), then take everything that
 * follows it.  Falls back to returning lines not present in `before`.
 *
 * NOTE: This heuristic works for typical Claude Code TUI output but may need
 * tuning once real pane captures are observed.
 */
function extractResponse(before: string, after: string, prompt: string): string {
  const anchor = prompt.split('\n')[0]!.trim().slice(0, 100);
  if (anchor) {
    const idx = after.lastIndexOf(anchor);
    if (idx !== -1) {
      const slice = after.slice(idx + anchor.length).trim();
      if (slice.length > 0) return slice;
    }
  }

  // Fallback: lines that are new in `after` compared to `before`.
  const beforeLines = new Set(before.split('\n'));
  const newLines = after
    .split('\n')
    .filter((l) => !beforeLines.has(l))
    .join('\n')
    .trim();
  return newLines || after.trim();
}

export const tmuxRunner = new TmuxRunner();
