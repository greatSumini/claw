/**
 * IC (이너서클) 온보딩 자동화.
 * ic-자기소개 채널에 메시지가 올라오면 4가지 조건을 검증하고
 * 통과 시 이너서클 역할을 부여한다.
 */

import { readFile } from 'node:fs/promises';
import type { GuildMember } from 'discord.js';
import { runClaude } from '../claude.js';
import { log } from '../log.js';

export const IC_INTRO_CHANNEL_ID = '1505053369943855198';
const IC_ROLE_ID = '1505050954792173568';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const VALIDATE_TIMEOUT_MS = 20_000;

interface RosterEntry {
  name: string;
  aliases?: string[];
}

interface OnboardingCheck {
  introValid: boolean;
  nicknameValid: boolean;
  avatarSet: boolean;
  inRoster: boolean;
  matchedName?: string;
}

let roster: RosterEntry[] = [];

export function loadRoster(rosterPath: string): void {
  void readFile(rosterPath, 'utf8')
    .then((raw) => {
      const data = JSON.parse(raw) as RosterEntry[];
      roster = Array.isArray(data) ? data : [];
      log.info({ count: roster.length }, 'IC roster loaded');
    })
    .catch((err: Error) => {
      log.warn({ err: err.message, path: rosterPath }, 'IC roster load failed');
    });
}

function checkNickname(member: GuildMember): boolean {
  const nick = member.nickname ?? '';
  return /^.+\/1기$/.test(nick);
}

function checkAvatar(member: GuildMember): boolean {
  return member.avatar !== null || member.user.avatar !== null;
}

function matchRoster(nickname: string | null): { matched: boolean; name?: string } {
  if (!nickname || roster.length === 0) return { matched: false };
  const baseName = nickname.split('/')[0].trim().toLowerCase();
  const found = roster.find((p) => {
    const candidates = [p.name, ...(p.aliases ?? [])].map((n) => n.toLowerCase());
    return candidates.some((n) => n.includes(baseName) || baseName.includes(n));
  });
  return found ? { matched: true, name: found.name } : { matched: false };
}

async function validateIntro(content: string, clawPath: string): Promise<boolean> {
  const prompt = `다음 Discord 메시지가 이너서클 자기소개 형식에 맞는지 판단하세요.
필수: 이름/닉네임, 직업 또는 도메인, 현재 AI로 풀고 있는 문제, 주고 싶거나 얻고 싶은 것.
JSON으로 응답: {"valid": true/false, "missing": [...]}

메시지:
${content}`;

  try {
    const result = await runClaude({
      cwd: clawPath,
      prompt,
      model: HAIKU_MODEL,
      timeoutMs: VALIDATE_TIMEOUT_MS,
    });
    const match = result.text.match(/\{[\s\S]*?\}/);
    if (!match) return false;
    const parsed = JSON.parse(match[0]) as { valid?: boolean };
    return parsed.valid === true;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'IC intro validation failed');
    return false;
  }
}

function buildFeedback(check: OnboardingCheck): string {
  const missing: string[] = [];
  if (!check.nicknameValid)
    missing.push('• 활동명을 **본명/1기** 형식으로 변경해주세요 (예: 홍길동/1기)');
  if (!check.avatarSet) missing.push('• 프로필 사진을 설정해주세요');
  if (!check.introValid) missing.push('• 자기소개 양식의 필수 항목을 모두 채워주세요');
  if (!check.inRoster)
    missing.push('• 참가자 명단에서 확인이 필요합니다. 운영진(@수민)에게 문의해주세요');

  return `아직 완료되지 않은 항목이 있습니다:\n${missing.join('\n')}\n\n완료 후 자기소개를 다시 올려주세요.`;
}

export async function handleIcIntro(
  member: GuildMember,
  content: string,
  clawPath: string,
  replyFn: (text: string) => Promise<void>,
): Promise<void> {
  if (member.roles.cache.has(IC_ROLE_ID)) return;

  const nicknameValid = checkNickname(member);
  const avatarSet = checkAvatar(member);
  const rosterMatch = matchRoster(member.nickname);
  const introValid = await validateIntro(content, clawPath);

  const check: OnboardingCheck = {
    introValid,
    nicknameValid,
    avatarSet,
    inRoster: rosterMatch.matched,
    matchedName: rosterMatch.name,
  };

  if (check.introValid && check.nicknameValid && check.avatarSet && check.inRoster) {
    await member.roles.add(IC_ROLE_ID);
    log.info({ userId: member.id, name: check.matchedName }, 'IC role assigned');
    await replyFn(`✅ 이너서클 1기 역할이 부여됐습니다, ${check.matchedName}님. 환영합니다!`);
  } else {
    log.info(
      {
        userId: member.id,
        nicknameValid,
        avatarSet,
        introValid,
        inRoster: rosterMatch.matched,
      },
      'IC onboarding check failed',
    );
    await replyFn(buildFeedback(check));
  }
}
