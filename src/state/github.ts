import type Database from 'better-sqlite3';

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
