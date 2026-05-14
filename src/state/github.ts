import type Database from 'better-sqlite3';

// ---------- github_issue_state ----------

interface GithubIssueStateDbRow {
  repo: string;
  last_issue_number: number;
  last_polled_at: string | null;
}

export interface GithubIssueStateRow {
  repo: string;
  lastIssueNumber: number;
  lastPolledAt: string | null;
}

export function getGithubIssueState(db: Database.Database, repo: string): GithubIssueStateRow | null {
  const stmt = db.prepare<[string], GithubIssueStateDbRow>(
    'SELECT repo, last_issue_number, last_polled_at FROM github_issue_state WHERE repo = ?',
  );
  const row = stmt.get(repo);
  if (!row) return null;
  return {
    repo: row.repo,
    lastIssueNumber: row.last_issue_number,
    lastPolledAt: row.last_polled_at,
  };
}

export function setGithubIssueState(db: Database.Database, repo: string, lastIssueNumber: number): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO github_issue_state (repo, last_issue_number, last_polled_at)
     VALUES (@repo, @lastIssueNumber, @now)
     ON CONFLICT(repo) DO UPDATE SET
       last_issue_number = excluded.last_issue_number,
       last_polled_at    = excluded.last_polled_at`,
  );
  stmt.run({ repo, lastIssueNumber, now });
}

// ---------- github_issue_threads ----------

interface GithubIssueThreadDbRow {
  repo: string;
  issue_number: number;
  discord_thread_id: string;
  discord_message_id: string | null;
  created_at: string;
}

export interface GithubIssueThreadRow {
  repo: string;
  issueNumber: number;
  discordThreadId: string;
  discordMessageId: string | null;
  createdAt: string;
}

export interface SetGithubIssueThreadArgs {
  repo: string;
  issueNumber: number;
  discordThreadId: string;
  discordMessageId?: string | null;
}

export function setGithubIssueThread(db: Database.Database, args: SetGithubIssueThreadArgs): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO github_issue_threads (repo, issue_number, discord_thread_id, discord_message_id, created_at)
     VALUES (@repo, @issueNumber, @discordThreadId, @discordMessageId, @now)
     ON CONFLICT(repo, issue_number) DO NOTHING`,
  );
  stmt.run({
    repo: args.repo,
    issueNumber: args.issueNumber,
    discordThreadId: args.discordThreadId,
    discordMessageId: args.discordMessageId ?? null,
    now,
  });
}

export function getGithubIssueThreadByIssue(
  db: Database.Database,
  repo: string,
  issueNumber: number,
): GithubIssueThreadRow | null {
  const stmt = db.prepare<[string, number], GithubIssueThreadDbRow>(
    'SELECT repo, issue_number, discord_thread_id, discord_message_id, created_at FROM github_issue_threads WHERE repo = ? AND issue_number = ?',
  );
  const row = stmt.get(repo, issueNumber);
  if (!row) return null;
  return {
    repo: row.repo,
    issueNumber: row.issue_number,
    discordThreadId: row.discord_thread_id,
    discordMessageId: row.discord_message_id,
    createdAt: row.created_at,
  };
}

export type AutoSolveStatus = 'classifying' | 'solving' | 'done' | 'skipped' | 'error';

export function updateGithubIssueAutoSolve(
  db: Database.Database,
  repo: string,
  issueNumber: number,
  status: AutoSolveStatus,
  prUrl?: string | null,
): void {
  const stmt = db.prepare(
    `UPDATE github_issue_threads
     SET auto_solve_status = @status, auto_solve_pr_url = @prUrl
     WHERE repo = @repo AND issue_number = @issueNumber`,
  );
  stmt.run({ repo, issueNumber, status, prUrl: prUrl ?? null });
}
