import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ButtonInteraction,
  type Channel,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import type Database from 'better-sqlite3';

import type { AppConfig, RepoEntry } from '../config.js';
import { log } from '../log.js';
import { runClaude, ClaudeError } from '../claude.js';
import { getSession, upsertSession } from '../state/sessions.js';
import { logEvent } from '../state/events.js';
import { emitEvent } from '../dashboard/event-bus.js';
import { routeMessage } from '../orchestrator/router.js';
import {
  buildRepoWorkSystemAppend,
  buildClawMaintenanceSystemAppend,
  buildAnalysisSystemAppend,
  CLAW_RESTART_MARKER,
} from '../orchestrator/prompt.js';
import {
  buildConversationTranscript,
  buildAnalysisPrompt,
} from '../orchestrator/auto-analysis.js';
import type { MessageContext } from '../messenger/types.js';
import type { MessengerAdapter } from '../messenger/types.js';
import { downloadAttachments, attachmentNote } from '../attachments.js';
import { setSenderPolicy } from '../state/mail.js';
import {
  upsertSessionAnalysis,
  findEligibleSessionsForAnalysis,
  type EligibleSession,
} from '../state/session-analyses.js';
import {
  enqueueMessage,
  getPendingMessages,
  deleteQueuedMessage,
} from '../state/message-queue.js';

// DiscordPoster kept as a re-export alias for backward compatibility.
export type { MessengerAdapter as DiscordPoster };

// ---------------------------------------------------------------------------
// Button customId helpers (pure functions — exported for testing)
// ---------------------------------------------------------------------------

const IGNORE_SENDER_PREFIX = 'ignore-sender';

export function buildIgnoreSenderButtonId(email: string, account: string): string {
  return `${IGNORE_SENDER_PREFIX}:${email}:${account}`;
}

export function parseIgnoreSenderButtonId(
  customId: string,
): { email: string; account: string } | null {
  if (!customId.startsWith(`${IGNORE_SENDER_PREFIX}:`)) return null;
  const rest = customId.slice(IGNORE_SENDER_PREFIX.length + 1);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return null;
  const email = rest.slice(0, colonIdx);
  const account = rest.slice(colonIdx + 1);
  if (!email || !account) return null;
  return { email, account };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCORD_MESSAGE_HARD_LIMIT = 2000;
const SAFE_CHUNK_SIZE = 1900; // headroom for the [i/N]\n prefix
const THREAD_NAME_MAX = 90; // Discord limit is 100; leave headroom
const DEFAULT_AUTO_ARCHIVE_MIN = 1440;
const TYPING_REFRESH_MS = 9_000;
const CLAUDE_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Helpers (exported for shape testing)
// ---------------------------------------------------------------------------

/**
 * Build a thread title from a user message:
 * - Strip leading mentions/punctuation
 * - Take the first sentence-ish chunk
 * - Sanitize newlines
 * - Truncate to THREAD_NAME_MAX (Discord limit is 100; headroom kept)
 */
export function makeThreadTitle(content: string): string {
  let s = (content ?? '').trim();
  // Strip leading user/role mentions (`<@123>`, `<@!123>`, `<@&123>`).
  s = s.replace(/^(?:<@[!&]?\d+>\s*)+/, '');
  // Strip leading punctuation.
  s = s.replace(/^[\s\p{P}]+/u, '');
  // Replace any whitespace runs (incl. newlines) with single space.
  s = s.replace(/\s+/g, ' ');
  // Take up to first sentence-end if reasonably short.
  const sentenceMatch = s.match(/^(.+?[.!?。！？])\s/);
  if (sentenceMatch && sentenceMatch[1].length <= THREAD_NAME_MAX) {
    s = sentenceMatch[1];
  }
  s = s.trim();
  if (s.length === 0) return 'untitled';
  if (s.length <= THREAD_NAME_MAX) return s;
  return s.slice(0, THREAD_NAME_MAX - 1).trimEnd() + '…';
}

/**
 * Robust message splitter:
 * - Try to split on paragraph (`\n\n`), then line (`\n`), then sentence (`. `), then char count
 * - Keep code fences balanced across chunks (close ``` on cut, reopen with same language on next)
 * - Each chunk ≤ maxLen
 * - If N > 1, prefix each chunk with `[i/N]\n`
 */
export function splitMessage(text: string, maxLen: number = SAFE_CHUNK_SIZE): string[] {
  if (typeof text !== 'string') {
    throw new Error('splitMessage: text must be a string');
  }
  if (!Number.isInteger(maxLen) || maxLen <= 0) {
    throw new Error('splitMessage: maxLen must be a positive integer');
  }

  const trimmed = text;
  if (trimmed.length === 0) return [''];

  // Reserve room for the "[i/N]\n" prefix in worst case. We don't know N up front,
  // so we conservatively reserve up to "[99/99]\n" → 8 chars.
  const PREFIX_RESERVE = 8;
  const bodyMax = Math.max(1, maxLen - PREFIX_RESERVE);

  // Greedy splitter that prefers breaking on better separators.
  const rawChunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > bodyMax) {
    const window = remaining.slice(0, bodyMax);

    let cutAt = -1;
    // Prefer paragraph break.
    const paraIdx = window.lastIndexOf('\n\n');
    if (paraIdx > bodyMax * 0.4) cutAt = paraIdx + 2;
    if (cutAt === -1) {
      const lineIdx = window.lastIndexOf('\n');
      if (lineIdx > bodyMax * 0.4) cutAt = lineIdx + 1;
    }
    if (cutAt === -1) {
      const sentIdx = window.lastIndexOf('. ');
      if (sentIdx > bodyMax * 0.4) cutAt = sentIdx + 2;
    }
    if (cutAt === -1) cutAt = bodyMax; // hard cut

    rawChunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }
  if (remaining.length > 0 || rawChunks.length === 0) {
    rawChunks.push(remaining);
  }

  // Re-balance code fences across chunks.
  const balanced: string[] = [];
  let openLang: string | null = null; // language tag of an unclosed fence carried over
  for (const chunkRaw of rawChunks) {
    // Scan the *raw* chunk content for fences, starting from carried-over state.
    const fenceRegex = /```([^\n`]*)\n?/g;
    let m: RegExpExecArray | null;
    let state: string | null = openLang;
    while ((m = fenceRegex.exec(chunkRaw)) !== null) {
      if (state === null) {
        // Opening fence: capture language tag (may be empty).
        state = (m[1] ?? '').trim();
      } else {
        // Closing fence.
        state = null;
      }
    }

    let chunk = chunkRaw;
    // If we entered this chunk inside an open fence, prepend a continuation fence.
    if (openLang !== null) {
      chunk = '```' + openLang + '\n' + chunk;
    }
    // If we exited still inside an open fence, close it for this chunk.
    if (state !== null) {
      chunk = chunk.replace(/\s+$/, '') + '\n```';
    }
    openLang = state;
    balanced.push(chunk);
  }

  // Apply [i/N]\n prefix when more than one chunk.
  const N = balanced.length;
  if (N <= 1) return balanced;
  const out = balanced.map((c, i) => `[${i + 1}/${N}]\n${c}`);

  // Final safety: enforce maxLen by hard-trimming if any chunk overshoots.
  return out.map((c) => (c.length <= maxLen ? c : c.slice(0, maxLen)));
}

/** Truncate a string to `max` characters using a horizontal ellipsis when shortened. */
export function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface DiscordAdapterOpts {
  config: AppConfig;
  db: Database.Database;
}

export class DiscordAdapter implements MessengerAdapter {
  readonly platform = 'discord';
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly client: Client;
  /** Per-thread (or per-channel for DMs) mutex chain. */
  private readonly threadLocks: Map<string, Promise<void>> = new Map();
  /** Number of Claude runs currently executing inside runWithMutex. */
  private inFlightCount = 0;
  /** Set when a restart has been requested; new messages are rejected until restart fires. */
  private pendingRestart: { channelLabel: string; threadKey: string } | null = null;
  private started = false;
  private stopped = false;
  private analysisTimer: NodeJS.Timeout | null = null;

  constructor(opts: DiscordAdapterOpts) {
    if (!opts || !opts.config) throw new Error('DiscordAdapter: config required');
    if (!opts.db) throw new Error('DiscordAdapter: db required');
    this.config = opts.config;
    this.db = opts.db;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.client.on(Events.MessageCreate, (msg) => {
      void this.onMessage(msg).catch((err) => {
        log.error(
          { err: (err as Error).message, stack: (err as Error).stack },
          'discord onMessage handler crashed',
        );
      });
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isButton()) return;
      void this.onButtonInteraction(interaction as ButtonInteraction).catch((err) => {
        log.error(
          { err: (err as Error).message },
          'discord button interaction handler crashed',
        );
      });
    });

    this.client.on(Events.ShardError, (err, shardId) => {
      log.error({ err: err.message, shardId }, 'discord shard error');
    });

    this.client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
      log.warn(
        { shardId, code: closeEvent?.code, reason: closeEvent?.reason },
        'discord shard disconnected',
      );
    });

    this.client.on(Events.Error, (err) => {
      log.error({ err: err.message }, 'discord client error');
    });

    let rejectReady: ((err: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      const onReady = (): void => {
        log.info(
          { user: this.client.user?.tag ?? '(unknown)' },
          'Discord ready',
        );
        resolve();
      };
      // Newer discord.js (v14.16+) renamed 'ready' → 'clientReady'.
      this.client.once(Events.ClientReady, onReady);
    });

    try {
      await Promise.all([
        this.client.login(this.config.env.DISCORD_BOT_TOKEN).then(
          () => undefined,
          (err: Error) => {
            if (rejectReady) rejectReady(err);
            throw err;
          },
        ),
        ready,
      ]);
    } catch (err) {
      this.started = false;
      throw err;
    }

    this.startAnalysisPoller();
    void this.processMessageQueue().catch((err) => {
      log.error({ err: (err as Error).message }, 'processMessageQueue crashed');
    });
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
    try {
      this.client.removeAllListeners();
      await this.client.destroy();
    } finally {
      log.info('Discord stopped');
    }
  }

  // -------------------------------------------------------------------------
  // Button interaction handling
  // -------------------------------------------------------------------------

  private async onButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseIgnoreSenderButtonId(interaction.customId);
    if (!parsed) return;

    const { email, account } = parsed;

    setSenderPolicy(this.db, { email, account, policy: 'ignore', reason: 'Discord 버튼으로 무시 설정' });

    log.info({ email, account }, 'sender ignored via button');
    logEvent(this.db, {
      type: 'importance.classify',
      summary: `button ignore: ${email}`,
      meta: { mode: 'button', verdict: 'ignore', from: email, account },
    });

    await interaction.reply({
      content: `앞으로 **${email}** 발신자의 메일은 무시합니다.`,
      flags: 64, // ephemeral
    });
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private async onMessage(msg: Message): Promise<void> {
    // Defense-in-depth filters.
    if (msg.author?.bot) return;
    if (!this.client.user) return; // not ready yet
    if (msg.author.id === this.client.user.id) return;
    const ownerId = this.config.env.DISCORD_OWNER_USER_ID;
    if (msg.author.id !== ownerId) {
      // Quietly drop — Discord ACL is the real gate.
      return;
    }

    // Drain in progress — queue the message and notify; will be replayed after restart.
    if (this.pendingRestart !== null) {
      try {
        enqueueMessage(this.db, msg.channelId, msg.id);
        await msg.reply('재시작 준비 중입니다. 재시작 완료 후 자동으로 처리됩니다.');
      } catch { /* ignore */ }
      return;
    }

    const ctx = await this.buildContext(msg);

    // Log inbound. (Don't double-log; routeDiscord logs router decisions.)
    logEvent(this.db, {
      type: 'discord.message.in',
      channel: ctx.channelName ?? ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: ctx.text.slice(0, 500),
      meta: {
        authorId: ctx.authorId,
        isMention: ctx.isMention,
        isDm: ctx.isDm === true,
      },
    });
    emitEvent({
      ts: new Date().toISOString(),
      type: 'discord.message.in',
      channel: ctx.channelName ?? ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: ctx.text.slice(0, 500),
    });

    let decision;
    try {
      decision = await routeMessage({ ctx, config: this.config, db: this.db });
    } catch (err) {
      log.error(
        { err: (err as Error).message, channel: ctx.channelName ?? ctx.channelId },
        'routeDiscord crashed',
      );
      return;
    }

    switch (decision.kind) {
      case 'ignore':
        log.debug(
          { channel: ctx.channelName ?? ctx.channelId, reason: decision.reason },
          'discord message ignored',
        );
        return;
      case 'trivial': {
        try {
          await msg.reply(truncate(decision.answer, DISCORD_MESSAGE_HARD_LIMIT));
        } catch (err) {
          log.error({ err: (err as Error).message }, 'failed to send trivial reply');
        }
        logEvent(this.db, {
          type: 'discord.message.out',
          channel: ctx.channelName ?? ctx.channelId,
          threadId: ctx.threadId ?? undefined,
          summary: decision.answer.slice(0, 500),
          meta: { mode: 'trivial' },
        });
        emitEvent({
          ts: new Date().toISOString(),
          type: 'discord.message.out',
          channel: ctx.channelName ?? ctx.channelId,
          threadId: ctx.threadId ?? undefined,
          summary: decision.answer.slice(0, 500),
        });
        return;
      }
      case 'repo-work':
        await this.handleRepoWork(msg, ctx, decision.repo, decision.instructions);
        return;
      case 'claw-maintenance':
        await this.handleClawMaintenance(msg, ctx);
        return;
      default: {
        // Exhaustiveness guard.
        const _exhaustive: never = decision;
        return _exhaustive;
      }
    }
  }

  private async buildContext(msg: Message): Promise<MessageContext> {
    const channel = msg.channel;
    const isDm = channel.isDMBased();
    const isThread = channel.isThread();

    let channelName: string | undefined;
    if (isDm) {
      channelName = 'dm';
    } else if (isThread) {
      // Thread name; fall back to parent channel registered name.
      const parentId = channel.parentId ?? '';
      const registered = this.config.repoChannels.find((r) => r.channelId === parentId);
      channelName =
        ('name' in channel && typeof channel.name === 'string' ? channel.name : undefined) ??
        registered?.channelName;
    } else {
      const registered = this.config.repoChannels.find((r) => r.channelId === channel.id);
      channelName =
        ('name' in channel && typeof channel.name === 'string' ? channel.name : undefined) ??
        registered?.channelName ??
        (channel.id === this.config.generalChannelId ? 'general' : undefined);
    }

    const ourId = this.client.user?.id ?? '';
    const isMention =
      (ourId !== '' && msg.mentions.users.has(ourId)) ||
      msg.mentions.repliedUser?.id === ourId;

    const cleanedText = stripLeadingMention(msg.content ?? '', ourId);

    // For routing: channelId is the *parent* channel ID when in a thread,
    // so repo-locked classification works. The thread ID is tracked separately.
    let routingChannelId: string;
    let threadId: string | null;
    if (isDm) {
      routingChannelId = channel.id;
      threadId = null;
    } else if (isThread) {
      routingChannelId = channel.parentId ?? channel.id;
      threadId = channel.id;
    } else {
      routingChannelId = channel.id;
      threadId = null;
    }

    const attachments = Array.from(msg.attachments.values()).map((a) => ({
      name: a.name ?? 'attachment',
      url: a.url,
    }));

    return {
      platform: 'discord',
      channelId: routingChannelId,
      channelName,
      threadId,
      authorId: msg.author.id,
      authorName: msg.author.username ?? msg.author.id,
      text: cleanedText,
      isMention,
      isDm,
      isBot: false,
      attachments,
    };
  }

  // -------------------------------------------------------------------------
  // Repo-work flow
  // -------------------------------------------------------------------------

  private async handleRepoWork(
    msg: Message,
    ctx: MessageContext,
    repo: RepoEntry,
    _instructions: string | undefined,
  ): Promise<void> {
    const channel = msg.channel;
    const isDm = channel.isDMBased();
    const isThread = channel.isThread();

    // 1. Determine target channel/thread + session key.
    let target: TargetChannel;
    let threadKey: string;
    try {
      if (isDm) {
        target = { kind: 'channel', channel: channel as TextSendable };
        threadKey = channel.id;
      } else if (isThread) {
        target = { kind: 'channel', channel: channel as TextSendable };
        threadKey = channel.id;
      } else {
        // Top-level message in a repo or general channel: open a thread.
        const title = makeThreadTitle(ctx.text || repo.fullName);
        const newThread = await msg.startThread({
          name: truncate(title, THREAD_NAME_MAX),
          autoArchiveDuration: DEFAULT_AUTO_ARCHIVE_MIN,
        });
        target = { kind: 'channel', channel: newThread as unknown as TextSendable };
        threadKey = newThread.id;
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, channel: ctx.channelName ?? ctx.channelId },
        'failed to resolve discord target / open thread',
      );
      return;
    }

    // 2. If this is a thread with no existing session (e.g. reply to a mail alert thread),
    //    fetch prior thread content so Claude has context.
    const existingSession = getSession(this.db, threadKey);
    const threadContext =
      isThread && !existingSession ? await this.fetchThreadContext(msg) : undefined;

    // 3. Per-thread mutex.
    await this.runWithMutex(threadKey, () =>
      this.runRepoWorkInThread(ctx, repo, target, threadKey, threadContext),
    );
  }

  private async runRepoWorkInThread(
    ctx: MessageContext,
    repo: RepoEntry,
    target: TargetChannel,
    threadKey: string,
    threadContext?: string,
  ): Promise<void> {
    const channelLabel = ctx.channelName ?? ctx.channelId;

    // Look up existing claude session.
    const sessionRow = getSession(this.db, threadKey);
    const resumeId = sessionRow?.claudeSessionId;

    // Typing indicator — refresh every 9s.
    const stopTyping = startTyping(target.channel);

    try {
      const savedPaths = await downloadAttachments(ctx.attachments ?? []);
      const baseText = ctx.text + attachmentNote(savedPaths);
      const userMessage = threadContext ? `${threadContext}\n\n${baseText}` : baseText;
      const systemAppend = buildRepoWorkSystemAppend({
        userMessage,
        repo,
        isContinuation: Boolean(resumeId),
      });

      logEvent(this.db, {
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `repo=${repo.fullName} resume=${Boolean(resumeId)}`,
        meta: { repo: repo.fullName, resume: Boolean(resumeId) },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `repo=${repo.fullName} resume=${Boolean(resumeId)}`,
      });

      let result;
      try {
        result = await runClaude({
          cwd: repo.localPath,
          prompt: userMessage,
          systemAppend,
          resume: resumeId,
          timeoutMs: CLAUDE_TIMEOUT_MS,
        });
      } catch (err) {
        const e = err instanceof ClaudeError ? err : (err as Error);
        log.error(
          { err: e.message, channel: channelLabel, threadId: threadKey, repo: repo.fullName },
          'claude run failed in repo-work',
        );
        logEvent(this.db, {
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
          meta: { repo: repo.fullName },
        });
        emitEvent({
          ts: new Date().toISOString(),
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
        });
        try {
          await safeSend(target.channel, `claude run failed: ${truncate(e.message, 1500)}`);
        } catch (sendErr) {
          log.error(
            { err: (sendErr as Error).message },
            'failed to post claude error message',
          );
        }
        return;
      }

      // Post the response.
      const chunks = splitMessage(result.text, SAFE_CHUNK_SIZE);
      for (const chunk of chunks) {
        try {
          await safeSend(target.channel, chunk);
        } catch (err) {
          log.error(
            { err: (err as Error).message, channel: channelLabel, threadId: threadKey },
            'failed to send response chunk',
          );
          break;
        }
      }

      // Persist session.
      try {
        upsertSession(this.db, {
          threadId: threadKey,
          claudeSessionId: result.sessionId,
          repo: repo.fullName,
          cwd: repo.localPath,
        });
      } catch (err) {
        log.error(
          { err: (err as Error).message, threadId: threadKey },
          'failed to upsert session',
        );
      }

      // Result + outbound logs.
      logEvent(this.db, {
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${result.text.length}chars`,
        meta: { duration_seconds: result.durationMs / 1000, repo: repo.fullName },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${result.text.length}chars`,
      });

      logEvent(this.db, {
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: result.text.slice(0, 500),
        meta: { chunks: chunks.length },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: result.text.slice(0, 500),
      });
    } finally {
      stopTyping();
    }
  }

  // -------------------------------------------------------------------------
  // Claw self-maintenance flow
  // -------------------------------------------------------------------------

  private async handleClawMaintenance(
    msg: Message,
    ctx: MessageContext,
  ): Promise<void> {
    const channel = msg.channel;
    const isThread = channel.isThread();

    let target: TargetChannel;
    let threadKey: string;
    try {
      if (isThread) {
        target = { kind: 'channel', channel: channel as TextSendable };
        threadKey = channel.id;
      } else {
        const title = makeThreadTitle(ctx.text || 'claw 유지보수');
        const newThread = await msg.startThread({
          name: truncate(title, THREAD_NAME_MAX),
          autoArchiveDuration: DEFAULT_AUTO_ARCHIVE_MIN,
        });
        target = { kind: 'channel', channel: newThread as unknown as TextSendable };
        threadKey = newThread.id;
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, channel: ctx.channelName ?? ctx.channelId },
        'failed to resolve discord target / open thread (claw-maintenance)',
      );
      return;
    }

    const existingSession = getSession(this.db, threadKey);
    const threadContext =
      isThread && !existingSession ? await this.fetchThreadContext(msg) : undefined;

    await this.runWithMutex(threadKey, () =>
      this.runClawMaintenanceInThread(ctx, target, threadKey, threadContext),
    );
  }

  private async runClawMaintenanceInThread(
    ctx: MessageContext,
    target: TargetChannel,
    threadKey: string,
    threadContext?: string,
  ): Promise<void> {
    const channelLabel = ctx.channelName ?? ctx.channelId;
    const cwd = this.config.clawRepoPath;

    const sessionRow = getSession(this.db, threadKey);
    const resumeId = sessionRow?.claudeSessionId;

    const stopTyping = startTyping(target.channel);

    try {
      const savedPaths = await downloadAttachments(ctx.attachments ?? []);
      const baseText = ctx.text + attachmentNote(savedPaths);
      const userMessage = threadContext ? `${threadContext}\n\n${baseText}` : baseText;
      const systemAppend = buildClawMaintenanceSystemAppend({
        isContinuation: Boolean(resumeId),
      });

      logEvent(this.db, {
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `claw-maintenance resume=${Boolean(resumeId)}`,
        meta: { target: 'claw', resume: Boolean(resumeId) },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `claw-maintenance resume=${Boolean(resumeId)}`,
      });

      let result;
      try {
        result = await runClaude({
          cwd,
          prompt: userMessage,
          systemAppend,
          resume: resumeId,
          timeoutMs: CLAUDE_TIMEOUT_MS,
        });
      } catch (err) {
        const e = err instanceof ClaudeError ? err : (err as Error);
        log.error(
          { err: e.message, channel: channelLabel, threadId: threadKey },
          'claude run failed in claw-maintenance',
        );
        logEvent(this.db, {
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
          meta: { target: 'claw' },
        });
        emitEvent({
          ts: new Date().toISOString(),
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
        });
        try {
          await safeSend(
            target.channel,
            `claude run failed: ${truncate(e.message, 1500)}`,
          );
        } catch (sendErr) {
          log.error(
            { err: (sendErr as Error).message },
            'failed to post claude error message (claw-maintenance)',
          );
        }
        return;
      }

      // Detect & strip restart marker before posting.
      const { text: visibleText, restart: markerRestart } = extractRestartMarker(result.text);

      // Fallback: if the marker was omitted, check git diff and force restart if src changed.
      let restart = markerRestart;
      if (!restart) {
        const srcModified = await checkSrcModifiedInLastCommit(cwd);
        if (srcModified) {
          log.warn(
            { channel: channelLabel, threadId: threadKey },
            'restart marker absent but src files modified in last commit — forcing restart',
          );
          restart = true;
        }
      }

      const chunks = splitMessage(visibleText, SAFE_CHUNK_SIZE);
      for (const chunk of chunks) {
        try {
          await safeSend(target.channel, chunk);
        } catch (err) {
          log.error(
            { err: (err as Error).message, channel: channelLabel, threadId: threadKey },
            'failed to send response chunk (claw-maintenance)',
          );
          break;
        }
      }

      try {
        upsertSession(this.db, {
          threadId: threadKey,
          claudeSessionId: result.sessionId,
          repo: 'greatSumini/claw',
          cwd,
        });
      } catch (err) {
        log.error(
          { err: (err as Error).message, threadId: threadKey },
          'failed to upsert session (claw-maintenance)',
        );
      }

      logEvent(this.db, {
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${visibleText.length}chars${restart ? ' [restart]' : ''}`,
        meta: {
          duration_seconds: result.durationMs / 1000,
          target: 'claw',
          restart,
        },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${visibleText.length}chars${restart ? ' [restart]' : ''}`,
      });

      logEvent(this.db, {
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: visibleText.slice(0, 500),
        meta: { chunks: chunks.length, target: 'claw', restart },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: visibleText.slice(0, 500),
      });

      // Schedule graceful restart after Discord post + session persist.
      if (restart) {
        this.scheduleGracefulRestart(channelLabel, threadKey);
      }
    } finally {
      stopTyping();
    }
  }

  // -------------------------------------------------------------------------
  // Mutex
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Graceful restart
  // -------------------------------------------------------------------------

  /**
   * Request a restart: reject new messages immediately, then fire launchctl
   * once all in-flight Claude runs complete. If nothing is in flight, fires now.
   */
  private scheduleGracefulRestart(channelLabel: string, threadKey: string): void {
    this.pendingRestart = { channelLabel, threadKey };
    log.info(
      { channel: channelLabel, threadId: threadKey, inFlight: this.inFlightCount },
      'claw restart scheduled — draining in-flight work',
    );
    if (this.inFlightCount === 0) {
      this.doRestart(channelLabel, threadKey);
    }
  }

  /** Spawn a detached launchctl kickstart. Called only after all work is drained. */
  private doRestart(channelLabel: string, threadKey: string): void {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const target = `gui/${uid}/com.claw`;
    log.info(
      { target, channel: channelLabel, threadId: threadKey },
      'triggering claw restart via launchctl (drain complete)',
    );
    try {
      const child = spawn('/bin/launchctl', ['kickstart', '-k', target], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (err) {
      log.error({ err: (err as Error).message }, 'failed to spawn claw restart');
    }
  }

  // -------------------------------------------------------------------------
  // Mutex
  // -------------------------------------------------------------------------

  private async runWithMutex(key: string, work: () => Promise<void>): Promise<void> {
    const prev = this.threadLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const myPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(key, myPromise);
    this.inFlightCount++;

    try {
      await prev;
    } catch {
      // Previous job's failure shouldn't block our turn.
    }

    try {
      await work();
    } finally {
      release();
      this.inFlightCount--;
      // Only delete if we're still the head of the chain.
      if (this.threadLocks.get(key) === myPromise) {
        this.threadLocks.delete(key);
      }
      // If all work is drained and a restart was requested, fire it now.
      if (this.pendingRestart !== null && this.inFlightCount === 0) {
        this.doRestart(this.pendingRestart.channelLabel, this.pendingRestart.threadKey);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Post-restart message queue
  // -------------------------------------------------------------------------

  private async processMessageQueue(): Promise<void> {
    const pending = getPendingMessages(this.db);
    if (pending.length === 0) return;

    log.info({ count: pending.length }, 'replaying queued messages after restart');

    for (const queued of pending) {
      // Delete first to avoid infinite re-queue if processing crashes.
      deleteQueuedMessage(this.db, queued.id);
      try {
        const channel = await this.client.channels.fetch(queued.channelId);
        if (!channel || !('messages' in channel)) {
          log.warn({ channelId: queued.channelId }, 'queued message: channel not found');
          continue;
        }
        const fetchedMsg = await (channel as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(queued.messageId);
        log.info({ channelId: queued.channelId, messageId: queued.messageId }, 'replaying queued message');
        await this.onMessage(fetchedMsg);
      } catch (err) {
        log.error(
          { err: (err as Error).message, channelId: queued.channelId, messageId: queued.messageId },
          'queued message: replay failed',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Auto-analysis poller
  // -------------------------------------------------------------------------

  private startAnalysisPoller(): void {
    const INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes
    this.analysisTimer = setInterval(() => {
      void this.runAnalysisCycle().catch((err) => {
        log.error({ err: (err as Error).message }, 'analysis poller crashed');
      });
    }, INTERVAL_MS);
    if (this.analysisTimer && typeof this.analysisTimer.unref === 'function') {
      this.analysisTimer.unref();
    }
  }

  private async runAnalysisCycle(): Promise<void> {
    if (this.pendingRestart !== null) return;

    let eligible: EligibleSession[];
    try {
      eligible = findEligibleSessionsForAnalysis(this.db);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'analysis: DB query failed');
      return;
    }

    for (const session of eligible) {
      if (this.pendingRestart !== null) break;
      try {
        await this.analyzeSession(session);
      } catch (err) {
        log.error(
          { err: (err as Error).message, threadId: session.threadId },
          'analysis: session analysis failed',
        );
      }
    }
  }

  private async analyzeSession(session: EligibleSession): Promise<void> {
    const { threadId, userMsgCount, repo } = session;
    const repoLabel = repo ?? 'unknown';
    log.info({ threadId, userMsgCount, repo: repoLabel }, 'analysis: starting');

    const transcript = buildConversationTranscript(this.db, threadId);
    const prompt = buildAnalysisPrompt(threadId, transcript, repoLabel);
    const systemAppend = buildAnalysisSystemAppend();

    let result;
    try {
      result = await runClaude({
        cwd: this.config.clawRepoPath,
        prompt,
        systemAppend,
        timeoutMs: CLAUDE_TIMEOUT_MS,
      });
    } catch (err) {
      log.error({ err: (err as Error).message, threadId }, 'analysis: claude run failed');
      return;
    }

    // Fetch the original thread and post the analysis.
    let thread;
    try {
      thread = await this.client.channels.fetch(threadId);
    } catch {
      log.warn({ threadId }, 'analysis: original thread not found');
      return;
    }
    if (!thread || !thread.isTextBased() || !('send' in thread)) {
      log.warn({ threadId }, 'analysis: thread not text-sendable');
      return;
    }
    const sendable = thread as unknown as TextSendable;

    const { text: visibleText } = extractRestartMarker(result.text);
    const header = '**[자동 분석 리포트]**\n\n';
    const chunks = splitMessage(header + visibleText, SAFE_CHUNK_SIZE);
    for (const chunk of chunks) {
      try {
        await safeSend(sendable, chunk);
      } catch (err) {
        log.error({ err: (err as Error).message, threadId }, 'analysis: send failed');
        break;
      }
    }

    upsertSessionAnalysis(this.db, {
      sourceThreadId: threadId,
      analysisSessionId: result.sessionId,
      analyzedAt: new Date().toISOString(),
      userMsgCount,
      status: 'done',
    });

    log.info({ threadId, sessionId: result.sessionId }, 'analysis: posted');
  }

  // -------------------------------------------------------------------------
  // Thread context helper
  // -------------------------------------------------------------------------

  /**
   * Fetch prior content from a thread so Claude can understand the original context
   * (e.g. a mail alert that created the thread). Only called when there is no
   * existing Claude session for the thread.
   */
  private async fetchThreadContext(msg: Message): Promise<string | undefined> {
    const channel = msg.channel;
    if (!channel.isThread()) return undefined;

    const lines: string[] = [];

    // The message that started the thread (typically the mail alert body).
    try {
      const starter = await channel.fetchStarterMessage({ cache: false });
      if (starter?.content) {
        const label = starter.author.bot ? '[알림]' : `[${starter.author.username}]`;
        lines.push(`${label}: ${starter.content}`);
      }
    } catch {
      // Thread may not have a starter message (e.g. forum threads).
    }

    // Messages sent inside the thread before the current one.
    try {
      const fetched = await channel.messages.fetch({ limit: 20, before: msg.id, cache: false });
      const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const m of sorted) {
        if (!m.content) continue;
        const label = m.author.bot ? '[claw]' : `[${m.author.username}]`;
        lines.push(`${label}: ${m.content}`);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'fetchThreadContext: messages.fetch failed');
    }

    if (lines.length === 0) return undefined;
    return `[스레드 이전 내용]\n${lines.join('\n')}\n---`;
  }

  // -------------------------------------------------------------------------
  // postToChannel — simple one-shot message to a channel (used by repo-sync)
  // -------------------------------------------------------------------------

  async postToChannel(channelId: string, content: string): Promise<void> {
    const channel: Channel | null = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`postToChannel: channel ${channelId} not found or not text-based`);
    }
    await safeSend(channel as unknown as TextSendable, content);
  }

  // -------------------------------------------------------------------------
  // postMailAlert (DiscordPoster)
  // -------------------------------------------------------------------------

  async postMailAlert(args: {
    channelId: string;
    threadName: string;
    initialMessage: string;
    senderEmail?: string;
    senderAccount?: string;
  }): Promise<{ threadId: string; firstMessageId: string }> {
    if (!args || typeof args.channelId !== 'string' || args.channelId.length === 0) {
      throw new Error('postMailAlert: channelId required');
    }
    if (typeof args.threadName !== 'string' || args.threadName.length === 0) {
      throw new Error('postMailAlert: threadName required');
    }
    if (typeof args.initialMessage !== 'string') {
      throw new Error('postMailAlert: initialMessage required');
    }

    const channel: Channel | null = await this.client.channels.fetch(args.channelId);
    if (!channel) {
      throw new Error(`postMailAlert: channel ${args.channelId} not found`);
    }
    if (!channel.isTextBased() || !('send' in channel) || typeof (channel as { send?: unknown }).send !== 'function') {
      throw new Error(`postMailAlert: channel ${args.channelId} is not text-sendable`);
    }
    const sendable = channel as unknown as TextSendable;

    const chunks = splitMessage(args.initialMessage, SAFE_CHUNK_SIZE);

    // Attach "이 발신자 무시" button if sender info provided.
    let components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (args.senderEmail && args.senderAccount) {
      const btn = new ButtonBuilder()
        .setCustomId(buildIgnoreSenderButtonId(args.senderEmail, args.senderAccount))
        .setLabel('이 발신자 무시')
        .setStyle(ButtonStyle.Secondary);
      components = [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)];
    }

    const firstMsg = await sendable.send({
      content: chunks[0] ?? '',
      components,
    });

    const truncatedName = truncate(args.threadName, THREAD_NAME_MAX);
    const thread = await firstMsg.startThread({
      name: truncatedName,
      autoArchiveDuration: DEFAULT_AUTO_ARCHIVE_MIN,
    });

    for (const chunk of chunks.slice(1)) {
      try {
        await thread.send(chunk);
      } catch (err) {
        log.error(
          { err: (err as Error).message, threadId: thread.id },
          'postMailAlert: failed to send follow-up chunk',
        );
        // Continue trying remaining chunks rather than abort entirely.
      }
    }

    return { threadId: thread.id, firstMessageId: firstMsg.id };
  }

  // -------------------------------------------------------------------------
  // sendFile — attach a local file to a channel or thread
  // -------------------------------------------------------------------------

  async sendFile(args: {
    channelId: string;
    threadId: string | null;
    filePath: string;
    caption?: string;
  }): Promise<void> {
    const targetId = args.threadId ?? args.channelId;
    const channel: Channel | null = await this.client.channels.fetch(targetId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`sendFile: channel/thread ${targetId} not found or not text-based`);
    }
    const attachment = new AttachmentBuilder(args.filePath, {
      name: path.basename(args.filePath),
    });
    const sendable = channel as unknown as TextSendable;
    await sendable.send({
      content: args.caption ?? '',
      files: [attachment],
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal duck type for any channel/thread we can `send` to and request typing on.
 * This avoids verbose discord.js conditional typing in our flow.
 */
interface TextSendable {
  send(content: string): Promise<Message>;
  send(options: {
    content?: string;
    files?: AttachmentBuilder[];
    components?: ActionRowBuilder<ButtonBuilder>[];
  }): Promise<Message>;
  sendTyping(): Promise<void>;
  id: string;
}

interface TargetChannel {
  kind: 'channel';
  channel: TextSendable;
}

function startTyping(channel: TextSendable): () => void {
  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;

  const fire = (): void => {
    if (cancelled) return;
    channel.sendTyping().catch((err) => {
      log.debug({ err: (err as Error).message }, 'sendTyping failed');
    });
    if (cancelled) return;
    timer = setTimeout(fire, TYPING_REFRESH_MS);
    // Don't keep the event loop alive on shutdown.
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  fire();

  return () => {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

async function safeSend(channel: TextSendable, content: string): Promise<void> {
  // Discord rejects empty content, so substitute a single space if needed.
  const payload = content.length === 0 ? ' ' : content;
  await channel.send(payload);
}

function stripLeadingMention(text: string, botUserId: string): string {
  if (!text) return '';
  if (!botUserId) return text.trim();
  // Strip one or more leading mentions of the bot (with or without `!`).
  const re = new RegExp(`^(?:<@!?${botUserId}>\\s*)+`);
  return text.replace(re, '').trim();
}

/**
 * Detect & strip the claw restart marker. Marker must appear on its own
 * (anywhere in the body, but typically the last line). The marker line is
 * removed entirely; surrounding whitespace is normalized.
 */
export function extractRestartMarker(text: string): { text: string; restart: boolean } {
  const idx = text.lastIndexOf(CLAW_RESTART_MARKER);
  if (idx === -1) return { text, restart: false };
  const before = text.slice(0, idx).replace(/\s+$/, '');
  const after = text.slice(idx + CLAW_RESTART_MARKER.length).replace(/^\s+/, '');
  const cleaned = after.length > 0 ? `${before}\n${after}` : before;
  return { text: cleaned.trimEnd(), restart: true };
}


const execFileAsync = promisify(execFile);

/**
 * Returns true if the most recent commit in the repo touched src/ or key config files.
 * Used as a fallback to catch cases where the Claude response omitted the restart marker.
 */
async function checkSrcModifiedInLastCommit(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      cwd,
    });
    const files = stdout.split('\n').filter(Boolean);
    return files.some(
      (f) => f.startsWith('src/') || f === 'package.json' || f === 'tsconfig.json',
    );
  } catch {
    return false;
  }
}

// Re-export types for downstream consumers (e.g. gmail adapter).
export type { TextBasedChannel };
