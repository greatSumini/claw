/**
 * GitHub Issues adapter — polls watched repos for new issues and posts
 * alerts to their corresponding Discord channels.
 *
 * Uses GH_TOKEN for authentication. Polls at MAIL_POLL_INTERVAL_SEC interval.
 * Bootstrap run records the current max issue number without alerting.
 */

import type Database from 'better-sqlite3';

import type { AppConfig, RepoEntry } from '../config.js';
import { log } from '../log.js';
import { logEvent } from '../state/events.js';
import { getGithubIssueState, setGithubIssueState } from '../state/github.js';
import { emitEvent } from '../dashboard/event-bus.js';

interface ChannelPoster {
  postToChannel(channelId: string, content: string): Promise<void>;
}

interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  pull_request?: unknown;
  labels: Array<{ name: string }>;
}

interface GitHubIssueAdapterOpts {
  config: AppConfig;
  db: Database.Database;
  poster: ChannelPoster;
}

function formatKst(iso: string): string {
  let date: Date;
  try {
    date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
  } catch {
    return iso;
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const out = fmt.format(date).replace(', ', ' ').replace(',', ' ');
  return `${out} KST`;
}

export class GitHubIssueAdapter {
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly poster: ChannelPoster;
  private readonly repos: RepoEntry[];
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(opts: GitHubIssueAdapterOpts) {
    this.config = opts.config;
    this.db = opts.db;
    this.poster = opts.poster;
    this.repos = opts.config.repoChannels.filter((r) => r.watchIssues);
    this.intervalMs = Math.max(60_000, opts.config.env.MAIL_POLL_INTERVAL_SEC * 1000);
  }

  async start(): Promise<void> {
    if (this.repos.length === 0) {
      log.warn('github adapter: no repos configured with watchIssues — skipping');
      return;
    }
    log.info(
      { repos: this.repos.map((r) => r.fullName), intervalMs: this.intervalMs },
      'github adapter starting',
    );
    await this.runCycle();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      if (this.cycleInFlight) {
        log.debug('github adapter: previous cycle still running, skipping tick');
        return;
      }
      void this.runCycle();
    }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('github adapter stopped');
  }

  // ---------- internals ----------

  private async runCycle(): Promise<void> {
    if (this.cycleInFlight) return;
    const p = this.doCycle().finally(() => {
      this.cycleInFlight = null;
    });
    this.cycleInFlight = p;
    await p;
  }

  private async doCycle(): Promise<void> {
    for (const repo of this.repos) {
      if (this.stopped) return;
      try {
        await this.pollRepo(repo);
      } catch (err) {
        log.error(
          { repo: repo.fullName, err: (err as Error).message },
          'github cycle: per-repo error',
        );
      }
    }
  }

  private async pollRepo(repo: RepoEntry): Promise<void> {
    const state = getGithubIssueState(this.db, repo.fullName);

    const url = `https://api.github.com/repos/${repo.fullName}/issues?state=all&sort=created&direction=desc&per_page=20`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'claw-bot/1.0',
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      log.error({ repo: repo.fullName, status: resp.status, body }, 'github: API error');
      return;
    }

    const issues = (await resp.json()) as GitHubIssue[];

    // Bootstrap: record current max issue number, skip alerting backlog.
    if (!state) {
      const maxNum = issues.length > 0 ? Math.max(...issues.map((i) => i.number)) : 0;
      setGithubIssueState(this.db, repo.fullName, maxNum);
      log.info({ repo: repo.fullName, maxIssueNumber: maxNum }, 'github bootstrap complete');
      return;
    }

    // Filter PRs out (GitHub issues endpoint includes PRs) and find new ones.
    const newIssues = issues
      .filter((i) => !i.pull_request && i.number > state.lastIssueNumber)
      .sort((a, b) => a.number - b.number); // oldest first

    if (newIssues.length === 0) return;

    for (const issue of newIssues) {
      if (this.stopped) break;
      await this.postIssueAlert(repo, issue);
    }

    const newMax = Math.max(...newIssues.map((i) => i.number), state.lastIssueNumber);
    setGithubIssueState(this.db, repo.fullName, newMax);

    log.info(
      { repo: repo.fullName, count: newIssues.length, newMax },
      'github: new issues posted',
    );
  }

  private async postIssueAlert(repo: RepoEntry, issue: GitHubIssue): Promise<void> {
    const author = issue.user?.login ?? '(unknown)';
    const ts = formatKst(issue.created_at);
    const labelStr = issue.labels.map((l) => `\`${l.name}\``).join(' ');

    const lines = [
      `🐛 **새 이슈 #${issue.number}**: ${issue.title}`,
      `📁 ${repo.fullName} | 👤 ${author} | 📅 ${ts}${labelStr ? ` | ${labelStr}` : ''}`,
      issue.html_url,
    ];

    try {
      await this.poster.postToChannel(repo.channelId, lines.join('\n'));
      logEvent(this.db, {
        type: 'github.issue.alert',
        channel: repo.channelName,
        summary: `#${issue.number} ${issue.title}`,
        meta: { repo: repo.fullName, issueNumber: issue.number, author },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'github.issue.alert',
        channel: repo.channelName,
        summary: `#${issue.number} ${issue.title}`,
      });
    } catch (err) {
      log.error(
        { repo: repo.fullName, issue: issue.number, err: (err as Error).message },
        'github: discord post failed',
      );
    }
  }
}
