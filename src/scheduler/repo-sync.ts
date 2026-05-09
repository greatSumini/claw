import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SCHEDULE_HOURS_KST = [7, 13];

function nextScheduledTime(): Date {
  const nowKST = new Date(Date.now() + KST_OFFSET_MS);
  const curHour = nowKST.getUTCHours();
  const curMin = nowKST.getUTCMinutes();
  const curSec = nowKST.getUTCSeconds();

  for (const hour of SCHEDULE_HOURS_KST) {
    if (curHour < hour || (curHour === hour && curMin === 0 && curSec === 0)) {
      const target = new Date(nowKST);
      target.setUTCHours(hour, 0, 0, 0);
      return new Date(target.getTime() - KST_OFFSET_MS);
    }
  }

  // All times passed today — schedule for first time tomorrow
  const tomorrow = new Date(nowKST);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(SCHEDULE_HOURS_KST[0], 0, 0, 0);
  return new Date(tomorrow.getTime() - KST_OFFSET_MS);
}

interface SyncTarget {
  fullName: string;
  localPath: string;
}

async function gitSyncRepo(target: SyncTarget): Promise<string> {
  const { fullName, localPath } = target;
  try {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: localPath });

    const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: localPath,
    });
    const branch = branchOut.trim();

    if (branch === 'HEAD') {
      return `${fullName}: detached HEAD, skipped`;
    }

    // Try fast-forward merge first
    try {
      const { stdout } = await execFileAsync('git', ['merge', '--ff-only', `origin/${branch}`], {
        cwd: localPath,
      });
      const line = stdout.trim().split('\n').pop() ?? 'ok';
      return `${fullName} [${branch}]: ${line}`;
    } catch {
      // Fall back to rebase
      try {
        const { stdout } = await execFileAsync('git', ['rebase', `origin/${branch}`], { cwd: localPath });
        const line = stdout.trim().split('\n').pop() ?? 'rebased';
        return `${fullName} [${branch}]: rebased — ${line}`;
      } catch (rebaseErr) {
        await execFileAsync('git', ['rebase', '--abort'], { cwd: localPath }).catch(() => {});
        const msg = (rebaseErr as Error).message.split('\n')[0];
        return `${fullName} [${branch}]: FAIL — ${msg}`;
      }
    }
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0];
    return `${fullName}: FAIL — ${msg}`;
  }
}

export class RepoSyncScheduler {
  private readonly config: AppConfig;
  private readonly notify: ((msg: string) => Promise<void>) | null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(config: AppConfig, notify?: (msg: string) => Promise<void>) {
    this.config = config;
    this.notify = notify ?? null;
  }

  start(): void {
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const next = nextScheduledTime();
    const delay = Math.max(0, next.getTime() - Date.now());
    log.info({ nextSync: next.toISOString(), delayMs: delay }, 'repo-sync: next scheduled');
    this.timer = setTimeout(() => {
      void this.run().finally(() => {
        if (!this.stopped) this.scheduleNext();
      });
    }, delay);
  }

  private async run(): Promise<void> {
    const targets: SyncTarget[] = [
      ...this.config.repoChannels,
      { fullName: 'greatSumini/claw', localPath: this.config.clawRepoPath },
    ];

    log.info({ count: targets.length }, 'repo-sync: running git pull on all repos');

    const results = await Promise.allSettled(targets.map(gitSyncRepo));
    const lines = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : `${targets[i].fullName}: ERROR — ${(r.reason as Error).message}`,
    );

    log.info({ results: lines }, 'repo-sync: done');

    if (this.notify) {
      const kstNow = new Date(Date.now() + KST_OFFSET_MS);
      const hhmm = `${String(kstNow.getUTCHours()).padStart(2, '0')}:${String(kstNow.getUTCMinutes()).padStart(2, '0')}`;
      const msg = `**[repo-sync ${hhmm} KST]**\n${lines.map((l) => `• ${l}`).join('\n')}`;
      await this.notify(msg).catch((err) => log.error({ err }, 'repo-sync: notify failed'));
    }
  }
}
