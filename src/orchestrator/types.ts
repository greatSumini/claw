import type { RepoEntry } from '../config.js';

export interface DiscordMessageContext {
  channelId: string;
  /** Channel name, e.g. "vmc-context-hub", "일반". Optional — adapters may not always know. */
  channelName?: string;
  /** null = top-level channel post (not inside a thread) */
  threadId: string | null;
  authorId: string;
  authorName: string;
  text: string;
  /** True if claw was @-mentioned in this message. */
  isMention: boolean;
  /** True if this message arrived via DM. Adapters set this. */
  isDm?: boolean;
  /** True if the message author is the claw bot itself (defense-in-depth). */
  isBot?: boolean;
  attachments?: Array<{ name: string; url: string }>;
}

export type RouteDecision =
  | { kind: 'trivial'; answer: string }
  | { kind: 'repo-work'; repo: RepoEntry; instructions?: string }
  | { kind: 'ignore'; reason: string };

export interface MailSummary {
  /** Recipient account email — the inbox this mail landed in. */
  account: string;
  /** Gmail message id */
  messageId: string;
  /** Gmail thread id */
  threadId: string;
  /** Sender — display + email, e.g. "Foo Bar <foo@bar.com>" */
  from: string;
  /** Bare sender email, lowercased canonical */
  fromEmail: string;
  subject: string;
  /** ISO 8601 received timestamp */
  receivedAtIso: string;
  /** Gmail's snippet field — short preview */
  snippet: string;
  /** Optional plain-text body. The classifier truncates internally. */
  bodyText?: string;
}

export type ImportanceVerdict =
  | {
      kind: 'important';
      oneLineSummary: string;
      suggestedActions: string[];
      contextNotes?: string;
    }
  | { kind: 'ambiguous'; oneLineSummary: string; reason: string }
  | { kind: 'ignore'; reason: string };

export type { RepoEntry };
