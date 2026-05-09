import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDb, closeDb } from '../state/db.js';
import { runMigrations } from '../state/migrations.js';
import {
  upsertSession,
  getSession,
  listRecentSessions,
  deleteSession,
} from '../state/sessions.js';
import {
  logEvent,
  listRecentEvents,
  listEventsByThread,
  countEventsByType,
} from '../state/events.js';
import {
  getMailState,
  setMailState,
  getSenderPolicy,
  setSenderPolicy,
  listSenderPolicies,
  createMailThread,
  getMailThread,
  getMailThreadByGmailMsg,
  setMailThreadStatus,
} from '../state/mail.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function makeTempDbPath(suffix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `claw-test-${suffix}-`));
  return path.join(dir, 'test.db');
}

function cleanupDbPath(dbFile: string): void {
  closeDb(dbFile);
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbFile + ext;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  // Remove the parent directory (created by mkdtempSync).
  try {
    fs.rmdirSync(path.dirname(dbFile));
  } catch {
    /* ignore */
  }
}

describe('state: migrations', () => {
  let dbFile: string;

  before(() => {
    dbFile = makeTempDbPath('migrations');
  });

  after(() => {
    cleanupDbPath(dbFile);
  });

  test('migrations apply on first getDb call', () => {
    const db = getDb(dbFile);
    const row = db
      .prepare<[string], { name: string }>(
        'SELECT name FROM _migrations WHERE name = ?',
      )
      .get('001_init');
    assert.equal(row?.name, '001_init');
  });

  test('migrations are idempotent on re-run', () => {
    const db = getDb(dbFile);
    runMigrations(db);
    runMigrations(db);
    const rows = db
      .prepare<[], { name: string }>('SELECT name FROM _migrations ORDER BY name')
      .all();
    // Each migration appears exactly once despite multiple runMigrations calls.
    const names = rows.map((r) => r.name);
    assert.deepEqual(names, [...new Set(names)], 'duplicate migration rows found');
    assert.ok(names.includes('001_init'));
    assert.ok(names.includes('002_session_analyses'));
  });

  test('getDb caches instances per path', () => {
    const a = getDb(dbFile);
    const b = getDb(dbFile);
    assert.strictEqual(a, b);
  });
});

describe('state: sessions', () => {
  let dbFile: string;

  before(() => {
    dbFile = makeTempDbPath('sessions');
  });

  after(() => {
    cleanupDbPath(dbFile);
  });

  test('upsertSession: insert sets created_at == updated_at', () => {
    const db = getDb(dbFile);
    upsertSession(db, {
      threadId: 't-1',
      claudeSessionId: 'cs-1',
      repo: 'org/repo',
      cwd: '/tmp/repo',
    });
    const s = getSession(db, 't-1');
    assert.ok(s, 'session exists');
    assert.equal(s!.threadId, 't-1');
    assert.equal(s!.claudeSessionId, 'cs-1');
    assert.equal(s!.repo, 'org/repo');
    assert.equal(s!.cwd, '/tmp/repo');
    assert.equal(s!.createdAt, s!.updatedAt);
  });

  test('upsertSession: update advances updated_at, preserves created_at', async () => {
    const db = getDb(dbFile);
    const first = getSession(db, 't-1');
    assert.ok(first);
    const originalCreatedAt = first!.createdAt;

    await sleep(10);
    upsertSession(db, {
      threadId: 't-1',
      claudeSessionId: 'cs-1-updated',
      repo: 'org/repo',
      cwd: '/tmp/repo',
    });
    const after = getSession(db, 't-1');
    assert.ok(after);
    assert.equal(after!.claudeSessionId, 'cs-1-updated');
    assert.equal(after!.createdAt, originalCreatedAt);
    assert.notEqual(after!.updatedAt, originalCreatedAt);
  });

  test('getSession returns null on missing thread', () => {
    const db = getDb(dbFile);
    assert.equal(getSession(db, 'does-not-exist'), null);
  });

  test('listRecentSessions: ordered by updated_at DESC', async () => {
    const db = getDb(dbFile);
    await sleep(10);
    upsertSession(db, {
      threadId: 't-2',
      claudeSessionId: 'cs-2',
      repo: 'org/repo2',
      cwd: '/tmp/repo2',
    });
    const list = listRecentSessions(db, 10);
    assert.equal(list.length, 2);
    assert.equal(list[0]!.threadId, 't-2');
    assert.equal(list[1]!.threadId, 't-1');
  });

  test('deleteSession removes the row', () => {
    const db = getDb(dbFile);
    deleteSession(db, 't-2');
    assert.equal(getSession(db, 't-2'), null);
    assert.equal(listRecentSessions(db, 10).length, 1);
  });

  test('upsertSession: throws on missing required fields', () => {
    const db = getDb(dbFile);
    assert.throws(() =>
      upsertSession(db, {
        threadId: '',
        claudeSessionId: 'x',
        repo: 'r',
        cwd: '/tmp',
      }),
    );
  });
});

describe('state: events', () => {
  let dbFile: string;

  before(() => {
    dbFile = makeTempDbPath('events');
  });

  after(() => {
    cleanupDbPath(dbFile);
  });

  test('logEvent stores meta as JSON; null when omitted', async () => {
    const db = getDb(dbFile);
    logEvent(db, {
      type: 'discord.in',
      channel: 'argos',
      threadId: 't-1',
      summary: 'user msg',
      meta: { authorId: 'u-1', tokens: 42 },
    });
    await sleep(5);
    logEvent(db, {
      type: 'discord.out',
      channel: 'argos',
      threadId: 't-1',
      summary: 'reply',
    });
    await sleep(5);
    logEvent(db, {
      type: 'mail.poll',
      summary: 'polled',
      meta: { newCount: 3 },
    });

    const events = listRecentEvents(db, 10);
    assert.equal(events.length, 3);
    // most recent first
    assert.equal(events[0]!.type, 'mail.poll');

    const e0 = events.find((e) => e.type === 'discord.in')!;
    assert.equal(e0.channel, 'argos');
    assert.equal(e0.threadId, 't-1');
    assert.ok(e0.metaJson);
    const meta = JSON.parse(e0.metaJson!);
    assert.equal(meta.authorId, 'u-1');
    assert.equal(meta.tokens, 42);

    const e1 = events.find((e) => e.type === 'discord.out')!;
    assert.equal(e1.metaJson, null);
  });

  test('listEventsByThread: ASC, filtered correctly', () => {
    const db = getDb(dbFile);
    const events = listEventsByThread(db, 't-1', 100);
    assert.equal(events.length, 2);
    // ASC order of insertion
    assert.equal(events[0]!.type, 'discord.in');
    assert.equal(events[1]!.type, 'discord.out');
  });

  test('countEventsByType', () => {
    const db = getDb(dbFile);
    assert.equal(countEventsByType(db, 'discord.in'), 1);
    assert.equal(countEventsByType(db, 'mail.poll'), 1);
    assert.equal(countEventsByType(db, 'no-such-type'), 0);
  });

  test('countEventsByType with sinceIso filter', () => {
    const db = getDb(dbFile);
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(countEventsByType(db, 'discord.in', future), 0);
    const past = new Date(Date.now() - 60_000).toISOString();
    assert.equal(countEventsByType(db, 'discord.in', past), 1);
  });

  test('logEvent throws on missing type', () => {
    const db = getDb(dbFile);
    assert.throws(() =>
      logEvent(db, { type: '', summary: 'x' }),
    );
  });

  test('listRecentEvents throws on bad limit', () => {
    const db = getDb(dbFile);
    assert.throws(() => listRecentEvents(db, 0));
    assert.throws(() => listRecentEvents(db, -1));
  });
});

describe('state: mail_state', () => {
  let dbFile: string;

  before(() => {
    dbFile = makeTempDbPath('mailstate');
  });

  after(() => {
    cleanupDbPath(dbFile);
  });

  test('getMailState returns null when missing', () => {
    const db = getDb(dbFile);
    assert.equal(getMailState(db, 'a@b.com'), null);
  });

  test('setMailState insert + update via upsert', () => {
    const db = getDb(dbFile);
    setMailState(db, 'a@b.com', '12345');
    const ms = getMailState(db, 'a@b.com');
    assert.ok(ms);
    assert.equal(ms!.account, 'a@b.com');
    assert.equal(ms!.lastHistoryId, '12345');
    assert.ok(ms!.lastPolledAt);

    setMailState(db, 'a@b.com', '99999');
    const ms2 = getMailState(db, 'a@b.com');
    assert.equal(ms2!.lastHistoryId, '99999');
  });

  test('setMailState rejects bad arguments', () => {
    const db = getDb(dbFile);
    assert.throws(() => setMailState(db, '', '1'));
    assert.throws(() => setMailState(db, 'a@b.com', 1 as unknown as string));
  });
});

describe('state: sender_policies', () => {
  let dbFile: string;

  before(() => {
    dbFile = makeTempDbPath('policies');
  });

  after(() => {
    cleanupDbPath(dbFile);
  });

  test('getSenderPolicy returns null when missing', () => {
    const db = getDb(dbFile);
    assert.equal(getSenderPolicy(db, 'spam@x.com', 'a@b.com'), null);
  });

  test('setSenderPolicy inserts; retrieved via getSenderPolicy', () => {
    const db = getDb(dbFile);
    setSenderPolicy(db, {
      email: 'spam@x.com',
      account: 'a@b.com',
      policy: 'ignore',
      reason: 'newsletter',
    });
    const sp = getSenderPolicy(db, 'spam@x.com', 'a@b.com');
    assert.ok(sp);
    assert.equal(sp!.policy, 'ignore');
    assert.equal(sp!.reason, 'newsletter');
  });

  test('setSenderPolicy upsert overwrites existing row', () => {
    const db = getDb(dbFile);
    setSenderPolicy(db, {
      email: 'spam@x.com',
      account: 'a@b.com',
      policy: 'whitelist',
      reason: 'changed mind',
    });
    const sp = getSenderPolicy(db, 'spam@x.com', 'a@b.com');
    assert.equal(sp!.policy, 'whitelist');
    assert.equal(sp!.reason, 'changed mind');
  });

  test('listSenderPolicies with and without account filter', () => {
    const db = getDb(dbFile);
    setSenderPolicy(db, {
      email: 'boss@company.com',
      account: 'a@b.com',
      policy: 'whitelist',
    });
    setSenderPolicy(db, {
      email: 'someone@elsewhere.com',
      account: 'other@y.com',
      policy: 'ignore',
    });

    const all = listSenderPolicies(db);
    assert.equal(all.length, 3);

    const aOnly = listSenderPolicies(db, 'a@b.com');
    assert.equal(aOnly.length, 2);
    assert.ok(aOnly.every((p) => p.account === 'a@b.com'));

    const empty = listSenderPolicies(db, 'no-such@host');
    assert.equal(empty.length, 0);
  });

  test('setSenderPolicy throws on invalid policy value', () => {
    const db = getDb(dbFile);
    assert.throws(
      () =>
        setSenderPolicy(db, {
          email: 'a@b.com',
          account: 'x@y.com',
          policy: 'bogus' as never,
        }),
      /policy must be/,
    );
  });
});

describe('state: mail_threads', () => {
  let dbFile: string;

  before(() => {
    dbFile = makeTempDbPath('threads');
  });

  after(() => {
    cleanupDbPath(dbFile);
  });

  test('createMailThread + getMailThread', () => {
    const db = getDb(dbFile);
    createMailThread(db, {
      discordThreadId: 'dt-1',
      gmailMsgId: 'gmsg-1',
      gmailThreadId: 'gthr-1',
      account: 'a@b.com',
      subject: 'Hello',
    });
    const mt = getMailThread(db, 'dt-1');
    assert.ok(mt);
    assert.equal(mt!.discordThreadId, 'dt-1');
    assert.equal(mt!.gmailMsgId, 'gmsg-1');
    assert.equal(mt!.subject, 'Hello');
    assert.equal(mt!.status, 'awaiting_user');
  });

  test('getMailThreadByGmailMsg lookup', () => {
    const db = getDb(dbFile);
    const mt = getMailThreadByGmailMsg(db, 'gmsg-1');
    assert.ok(mt);
    assert.equal(mt!.discordThreadId, 'dt-1');
    assert.equal(getMailThreadByGmailMsg(db, 'no-such'), null);
  });

  test('setMailThreadStatus transitions', () => {
    const db = getDb(dbFile);
    setMailThreadStatus(db, 'dt-1', 'in_progress');
    assert.equal(getMailThread(db, 'dt-1')!.status, 'in_progress');
    setMailThreadStatus(db, 'dt-1', 'resolved');
    assert.equal(getMailThread(db, 'dt-1')!.status, 'resolved');
  });

  test('createMailThread rejects invalid status', () => {
    const db = getDb(dbFile);
    assert.throws(() =>
      createMailThread(db, {
        discordThreadId: 'dt-bad',
        gmailMsgId: 'g',
        gmailThreadId: 'g',
        account: 'a@b.com',
        subject: 's',
        status: 'bogus' as never,
      }),
    );
  });

  test('setMailThreadStatus rejects invalid status', () => {
    const db = getDb(dbFile);
    assert.throws(() =>
      setMailThreadStatus(db, 'dt-1', 'bogus' as never),
    );
  });
});
