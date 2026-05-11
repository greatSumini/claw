import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';

import { loadConfig } from './config.js';
import { log } from './log.js';
import { getDb, closeDb } from './state/db.js';
import { mountDashboard } from './dashboard/routes.js';
import { DiscordAdapter } from './adapters/discord.js';
import { GmailAdapter } from './adapters/gmail.js';
import { RepoSyncScheduler } from './scheduler/repo-sync.js';
import { DreamingScheduler } from './scheduler/dreaming.js';

async function main(): Promise<void> {
  const config = loadConfig();

  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.mkdirSync(config.paths.logsDir, { recursive: true });

  log.info({ pid: process.pid, dbFile: config.paths.dbFile, repos: config.repoChannels.length }, 'claw starting');

  const db = getDb(config.paths.dbFile);

  // Express app + dashboard
  const app = express();
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });
  mountDashboard(app, { db, secret: config.env.DASHBOARD_SECRET });
  const server = app.listen(config.env.DASHBOARD_PORT, () => {
    log.info({ port: config.env.DASHBOARD_PORT }, 'dashboard listening');
  });

  // Discord
  const discord = new DiscordAdapter({ config, db });
  await discord.start();

  // Repo sync: polls every 10 min, only runs when idle 30+ min
  const repoSync = new RepoSyncScheduler(config, db, (msg) =>
    discord.postToChannel(config.clawChannelId, msg),
  );
  repoSync.start();

  // Dreaming: memory decay/promote during sleep hours, once per day
  const dreaming = new DreamingScheduler(db, (msg) =>
    discord.postToChannel(config.clawChannelId, msg),
  );
  dreaming.start();

  // Gmail (optional — only if configured)
  let gmail: GmailAdapter | null = null;
  const gmailReady = config.gmail.length > 0 && config.env.GMAIL_CLIENT_ID && config.env.GMAIL_CLIENT_SECRET;
  if (gmailReady) {
    gmail = new GmailAdapter({ config, db, poster: discord });
    await gmail.start();
    log.info({ accounts: config.gmail.length }, 'gmail adapter started');
  } else {
    log.warn(
      { configured: config.gmail.length, hasClient: !!config.env.GMAIL_CLIENT_ID },
      'gmail not configured — skipping (run scripts/gmail-auth.ts to enable)',
    );
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown initiated');
    try {
      server.close();
      repoSync.stop();
      dreaming.stop();
      await discord.stop();
      if (gmail) await gmail.stop();
      closeDb();
    } catch (err) {
      log.error({ err }, 'shutdown error');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: { message: err.message, stack: err.stack } }, 'uncaughtException');
    void shutdown('uncaughtException');
  });

  log.info('claw running');
}

main().catch((err) => {
  log.fatal({ err: { message: err.message, stack: err.stack } }, 'fatal startup error');
  process.exit(1);
});
