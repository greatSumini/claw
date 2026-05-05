import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';

const Schema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
  GH_TOKEN: z.string().min(1),

  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_PUBLIC_KEY: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_CHANNEL_GENERAL: z.string().min(1),
  DISCORD_CHANNEL_LIFE_OS: z.string().min(1),
  DISCORD_CHANNEL_VMC_CONTEXT_HUB: z.string().min(1),
  DISCORD_CHANNEL_ARGOS: z.string().min(1),
  DISCORD_CHANNEL_VOOSTER: z.string().min(1),
  DISCORD_OWNER_USER_ID: z.string().min(1),

  GMAIL_CLIENT_ID: z.string().optional().default(''),
  GMAIL_CLIENT_SECRET: z.string().optional().default(''),
  GMAIL_REFRESH_TOKEN_GREATSUMINI: z.string().optional().default(''),
  GMAIL_REFRESH_TOKEN_CURSORMATFIA: z.string().optional().default(''),
  GMAIL_REFRESH_TOKEN_LEAD_AWESOMEDEV: z.string().optional().default(''),
  GMAIL_REFRESH_TOKEN_SUMIN_VOOSTER: z.string().optional().default(''),

  MAIL_POLL_INTERVAL_SEC: z.coerce.number().default(600),

  DASHBOARD_PORT: z.coerce.number().default(3200),
  DASHBOARD_SECRET: z.string().min(8),

  REPOS_DIR: z.string().default('/Users/sumin/repos'),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), 'data')),
  LOGS_DIR: z.string().default(path.resolve(process.cwd(), 'logs')),
});

export type Env = z.infer<typeof Schema>;

export interface RepoEntry {
  /** Discord channel name → repo */
  channelName: string;
  /** Discord channel ID */
  channelId: string;
  /** owner/name */
  fullName: string;
  /** Local checkout path */
  localPath: string;
  /** Category — informs routing rules */
  category: 'personal' | 'code';
  /** Short description for prompts */
  description: string;
}

export interface GmailAccount {
  email: string;
  refreshToken: string;
  /** Display label used in Discord posts */
  label: string;
}

export interface AppConfig {
  env: Env;
  /** Channel ID → repo mapping for repo-locked channels */
  repoChannels: RepoEntry[];
  /** General channel — master claw, mention required */
  generalChannelId: string;
  /** Channel where mail alerts are posted (currently vmc-context-hub) */
  mailAlertChannelId: string;
  gmail: GmailAccount[];
  paths: {
    reposDir: string;
    dataDir: string;
    logsDir: string;
    dbFile: string;
  };
}

export function loadConfig(): AppConfig {
  const env = Schema.parse(process.env);

  const repoChannels: RepoEntry[] = [
    {
      channelName: 'life-os',
      channelId: env.DISCORD_CHANNEL_LIFE_OS,
      fullName: 'greatSumini/life-os',
      localPath: path.join(env.REPOS_DIR, 'greatSumini', 'life-os'),
      category: 'personal',
      description:
        '업무 외 모든 개인 맥락의 단일 진입점 — 운동·식단·요리·건강·독서·일상·인사이트. cooking/, fitness/ 서브도메인. 자체 .claude/skills/ 보유.',
    },
    {
      channelName: 'vmc-context-hub',
      channelId: env.DISCORD_CHANNEL_VMC_CONTEXT_HUB,
      fullName: 'vibemafiaclub/context-hub',
      localPath: path.join(env.REPOS_DIR, 'vibemafiaclub', 'context-hub'),
      category: 'code',
      description: 'B2B 업무 허브. 고객사 컨텍스트 누적되는 곳. 메일 알림도 이 채널로.',
    },
    {
      channelName: 'argos',
      channelId: env.DISCORD_CHANNEL_ARGOS,
      fullName: 'vibemafiaclub/argos',
      localPath: path.join(env.REPOS_DIR, 'vibemafiaclub', 'argos'),
      category: 'code',
      description: 'vibemafiaclub argos 프로젝트.',
    },
    {
      channelName: 'vooster',
      channelId: env.DISCORD_CHANNEL_VOOSTER,
      fullName: 'Vooster-AI/monorepo',
      localPath: path.join(env.REPOS_DIR, 'Vooster-AI', 'monorepo'),
      category: 'code',
      description: 'Vooster-AI monorepo (turbo/pnpm workspace).',
    },
  ];

  const gmail: GmailAccount[] = [
    { email: 'greatsumini@gmail.com', refreshToken: env.GMAIL_REFRESH_TOKEN_GREATSUMINI, label: 'greatsumini' },
    { email: 'cursormatfia@gmail.com', refreshToken: env.GMAIL_REFRESH_TOKEN_CURSORMATFIA, label: 'cursormatfia' },
    { email: 'lead@awesome.dev', refreshToken: env.GMAIL_REFRESH_TOKEN_LEAD_AWESOMEDEV, label: 'lead@awesome.dev' },
    { email: 'sumin@vooster.ai', refreshToken: env.GMAIL_REFRESH_TOKEN_SUMIN_VOOSTER, label: 'sumin@vooster' },
  ].filter((a) => a.refreshToken.length > 0);

  return {
    env,
    repoChannels,
    generalChannelId: env.DISCORD_CHANNEL_GENERAL,
    mailAlertChannelId: env.DISCORD_CHANNEL_VMC_CONTEXT_HUB,
    gmail,
    paths: {
      reposDir: env.REPOS_DIR,
      dataDir: env.DATA_DIR,
      logsDir: env.LOGS_DIR,
      dbFile: path.join(env.DATA_DIR, 'claw.db'),
    },
  };
}
