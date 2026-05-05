import type { RepoEntry } from '../config.js';

export interface RepoWorkPromptArgs {
  userMessage: string;
  repo: RepoEntry;
  /** If true, this is a follow-up turn in an existing thread; tone is slightly less formal. */
  isContinuation: boolean;
}

const BASE_LINES = [
  '한국어로 응답',
  '작업 끝나면 의미 단위로 git commit & push까지 완수. 첫 push 시 `gh auth setup-git` 먼저 (idempotent, GH_TOKEN 자동 인식). 실패 시 강행 금지(-f X), 보고만.',
  '최종 답변은 핵심만 간결히 (Discord에 그대로 전달됨, 2000자 이상 시 자동 분할됨)',
];

const LIFE_OS_HINT =
  'life-os 한정 힌트: 적절한 skill을 먼저 탐색·활용 (`/recommend-menu`, `/recipe`, `/coupang-cart`, `/fitness-log-workout` 등). 날짜는 `date +%y%m%d`로 얻어라.';

/**
 * Build the systemAppend block for a repo-work claude run.
 *
 * Encodes claw conventions:
 *  - Korean responses
 *  - commit & push when work-unit completes
 *  - terse final reply (Discord delivery)
 *  - this session is scoped to one repo
 *  - life-os specific skill hint
 */
export function buildRepoWorkSystemAppend(args: RepoWorkPromptArgs): string {
  const lines: string[] = [];
  lines.push('지시:');
  for (const line of BASE_LINES) {
    lines.push(`- ${line}`);
  }
  lines.push(
    `- 이 채널/세션은 ${args.repo.fullName} 전용. 다른 repo 작업 필요해 보이면 사용자에게 안내만.`,
  );
  if (args.repo.fullName === 'greatSumini/life-os') {
    lines.push(`- ${LIFE_OS_HINT}`);
  }
  if (args.isContinuation) {
    lines.push('- (이전 대화 이어가기 모드 — 같은 thread 안에서의 후속 메시지)');
  }
  return lines.join('\n');
}
