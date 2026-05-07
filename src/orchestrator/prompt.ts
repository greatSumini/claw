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

export interface ClawMaintenancePromptArgs {
  isContinuation: boolean;
}

/** 재실행 트리거 마커. claw가 응답에서 이 라인을 검출하면 본문에서 제거 후 launchctl kickstart 수행. */
export const CLAW_RESTART_MARKER = '__CLAW_RESTART__';

/**
 * Build the systemAppend block for a claw self-maintenance run.
 *
 * - cwd는 claw repo 자체 (`/Users/sumin/repos/greatSumini/claw`)
 * - 작업 후 commit & push
 * - 빌드 필요한 변경(소스/설정/빌드 파이프라인)이라면 응답 마지막에 마커 출력 → claw가 재실행
 */
export function buildClawMaintenanceSystemAppend(
  args: ClawMaintenancePromptArgs,
): string {
  const lines: string[] = [];
  lines.push('지시:');
  lines.push('- 한국어로 응답');
  lines.push(
    '- 이 세션은 claw 자체 유지보수 전용. cwd는 claw repo (`greatSumini/claw`). 다른 repo 작업 필요해 보이면 사용자에게 안내만.',
  );
  lines.push(
    '- 작업 끝나면 의미 단위로 git commit & push까지 완수. 첫 push 시 `gh auth setup-git` 먼저 (idempotent, GH_TOKEN 자동 인식). 실패 시 강행 금지(-f X), 보고만.',
  );
  lines.push(
    '- 소스/설정 변경(`src/**`, `package.json`, `tsconfig.json` 등 빌드 산출물에 영향)이면 `pnpm build`까지 완료해라. 그리고 **반영을 위해 claw 프로세스 재실행이 필요하면, 응답의 마지막 줄에 정확히 다음 마커만 출력**: `' +
      CLAW_RESTART_MARKER +
      '`. 마커는 claw가 검출해서 본문에서 제거 후 `launchctl kickstart -k gui/<uid>/com.claw`로 자동 재시작한다. (README/문서/테스트만 수정한 경우 마커 출력 불필요)',
  );
  lines.push('- 최종 답변은 핵심만 간결히 (Discord에 그대로 전달됨, 2000자 이상 시 자동 분할됨)');
  if (args.isContinuation) {
    lines.push('- (이전 대화 이어가기 모드 — 같은 thread 안에서의 후속 메시지)');
  }
  return lines.join('\n');
}
