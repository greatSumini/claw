# claw

> Discord/Gmail을 인터페이스로, `claude` CLI를 두뇌로 — macOS에서 24/7 돌아가는 개인 AI 에이전트 게이트웨이.

메신저에 메시지를 보내면 claw가 적절한 컨텍스트(스킬·메모리·레포)를 조립해 `claude --print`를 headless로 실행하고, 결과를 다시 채널로 돌려준다. 레포 코드 수정부터 이메일 초안까지 — 모두 채팅 하나로.

---

## 작동 원리

```
┌────────────────┐   ┌─────────────────┐
│   Discord      │   │   Gmail (×4)    │
│  (gateway)     │   │  (10분 폴링)    │
└───────┬────────┘   └────────┬────────┘
        │                     │
        └──────────┬──────────┘
                   │
          ┌────────▼────────┐
          │   Orchestrator  │
          │  ┌───────────┐  │
          │  │  Router   │  │  Haiku가 메시지 분류
          │  │ (classify)│  │  trivial / repo / unclear
          │  └─────┬─────┘  │
          │        │        │
          │  ┌─────▼─────┐  │
          │  │  Skill    │  │  SKILL.md 자동 감지 + 주입
          │  │ Detector  │  │
          │  └─────┬─────┘  │
          │        │        │
          │  ┌─────▼─────┐  │
          │  │  Memory   │  │  3-layer hybrid 검색
          │  │  Loader   │  │
          │  └─────┬─────┘  │
          └────────┼────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
   (trivial)             (repo work)
   즉시 답변            spawn claude
                    --print --resume <id>
                    cwd = repo 디렉터리
                    systemAppend = 스킬+메모리
                         │
                         ▼
                  ┌─────────────┐
                  │   SQLite    │
                  │  sessions   │
                  │  memories   │
                  │   events    │
                  └──────┬──────┘
                         │
                         ▼
              Discord thread 응답 + 파일 첨부
```

### 핵심 루프

1. **분류** — Haiku가 메시지를 보고 `trivial` / `repo` / `unclear` 중 하나로 분류
2. **스킬 주입** — `claw/skills/` + 레포의 `.claude/skills/`에서 가장 관련된 SKILL.md를 찾아 `systemAppend`에 삽입
3. **메모리 주입** — 관련 메모리를 hybrid 검색(BM25 + 임베딩)으로 가져와 함께 주입
4. **Claude 실행** — `claude --print --resume <session_id>` headless 실행, 결과 수신
5. **응답 전송** — Discord thread에 포스팅 (2000자 자동 분할, 파일 첨부 지원)
6. **사후 분석** — 2시간마다 완료된 thread를 재분석해 스킬 제안·메모리 업데이트

---

## 주요 기능

### 스킬 시스템

```
claw/skills/
└── b2b-email/
    └── SKILL.md      ← name, description, triggers + 주입 내용

{repo}/.claude/skills/
└── add-api-endpoint/
    └── SKILL.md      ← 레포 전용 스킬
```

- SKILL.md의 `triggers` 키워드를 기반으로 Haiku가 자동 선택
- 선택된 스킬의 본문이 Claude 실행 전 `systemAppend`에 주입됨
- **Claw 스킬**: 커뮤니케이션 패턴 등 레포 무관 지식 (`claw/skills/`)
- **레포 스킬**: 특정 레포 코드베이스 패턴 (`{repo}/.claude/skills/`)
- 세션 내 짧은 후속 메시지(<15자)는 직전 스킬 자동 재사용

### 3-Layer 메모리 시스템

| Layer | 저장소 | TTL | 설명 |
|-------|--------|-----|------|
| 1. Candidate | `memories_candidate` | 7일 | 단기 기억. `!기억` 단축어·자동 추출로 저장 |
| 2. Active | `memories` | 영구 | 점수 0~1000+. 참조·분석으로 승격 |
| 3. Embedding | `memories.embedding` | — | 온디바이스 HuggingFace 임베딩 |

- **스코프**: `global` / `repo:{name}` / `channel:{id}` 3단계
- **하이브리드 검색**: BM25 키워드 + 코사인 유사도 혼합 (60/20/20 가중치)
- **Decay**: 밤 시간 DreamingScheduler가 오래된 메모리 점수 감소

### 세션 연속성

- Discord thread ↔ Claude `session_id` 매핑 (SQLite)
- 같은 thread의 후속 메시지는 `--resume`으로 동일 세션 재진입
- 스레드별 mutex로 동시 실행 방지

### 자동 재시작

Claude가 소스를 수정한 뒤 응답에 `__CLAW_RESTART__` 마커를 포함하면:

1. claw가 마커를 제거하고 Discord에 나머지 텍스트 전송
2. `pnpm build` (자동)
3. `launchctl kickstart -k gui/<uid>/com.claw`
4. 재시작 중 수신된 메시지는 queue에 저장 후 재생

### 자동 분석

완료된 thread를 2시간마다 Haiku로 재분석:
- **스킬 제안**: 반복 패턴 감지 → 대시보드에 pending 스킬 제안 생성
- **메모리 점수 조정**: 유용했던 메모리 점수 상향, 무관한 메모리 하향
- 대시보드에서 제안된 스킬 원클릭 승인 → `create-skill` Discord 버튼

### Gmail 통합

- 4개 계정 10분 주기 폴링
- Claude가 중요도 판정 → 중요 메일만 `vmc-context-hub` 채널에 thread 생성
- `ignore-sender` 버튼으로 발신자 정책 관리

---

## 아키텍처 세부

### 레포 레지스트리

`config.ts`에서 채널 → 레포 매핑을 정의. 특정 채널의 메시지는 해당 레포 디렉터리에서 Claude를 실행.

```ts
{ channelId: 'xxx', repo: 'vibemafiaclub/context-hub', cwd: '/Users/sumin/repos/...' }
```

### 데이터베이스 (SQLite)

| 테이블 | 용도 |
|--------|------|
| `sessions` | thread_id → claude session_id, 레포, 마지막 스킬 |
| `memories` | 활성 메모리 (스코프, 태그, 점수, 임베딩) |
| `memories_candidate` | 단기 후보 메모리 |
| `events` | 전체 이벤트 감사 로그 (FTS5 전문검색) |
| `skill_proposals` | 자동 감지된 스킬 제안 (pending/approved) |
| `message_queue` | 재시작 중 수신 메시지 버퍼 |
| `sender_policies` | Gmail 발신자 허용/차단 정책 |

### 대시보드

htmx 기반 SSR 대시보드 (`:3200`):
- 이벤트 뷰어 (FTS5 전문검색)
- 세션 히스토리
- 메모리 브라우저
- 스킬 제안 큐 (승인/거절)

---

## 기술 스택

| 레이어 | 선택 |
|--------|------|
| 런타임 | Node.js (TypeScript, esbuild 번들) |
| 상태 저장 | SQLite (better-sqlite3, WAL 모드) |
| Discord | discord.js v14 |
| Gmail | googleapis (OAuth 2.0) |
| 임베딩 | @xenova/transformers (온디바이스) |
| LLM 오케스트레이션 | Claude CLI headless (`claude --print`) |
| 분류기 | Claude Haiku (라우터, 스킬 감지, 중요도) |
| 대시보드 | Express + htmx |
| 데몬 | macOS launchd (`KeepAlive: true`) |

---

## 셋업

```bash
# 1. 의존성
pnpm install

# 2. 환경변수
cp .env.example .env
# .env 편집: Discord 토큰, Gmail OAuth, GitHub PAT, Claude 인증

# 3. Gmail 인증 (계정별 1회)
tsx scripts/gmail-auth.ts greatsumini@gmail.com

# 4. DB 초기화
pnpm run migrate

# 5. 빌드 & 실행
pnpm build
node dist/server.js

# 또는 개발 모드 (tsx watch)
pnpm dev
```

### macOS 데몬 등록

```bash
# LaunchAgent 등록 (로그인 시 자동 시작)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claw.plist

# 상태 확인
launchctl list | grep com.claw

# 코드 수정 후 재시작
pnpm build && launchctl kickstart -k gui/$(id -u)/com.claw

# 로그
tail -f logs/launchd.log logs/launchd.error.log
```

---

## 스킬 추가

```bash
mkdir -p skills/my-skill
cat > skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: 한 줄 설명 (Haiku 분류기가 사용)
triggers:
  - 트리거 키워드 1
  - 트리거 키워드 2
---

# 주입될 내용
Claude에게 전달할 지침...
EOF

git add skills/my-skill/SKILL.md
git commit -m "feat: my-skill 추가"
git push
```

> **레포 전용 스킬**은 `{repo}/.claude/skills/` 하위에 같은 포맷으로 작성.

---

## 다른 머신에 이전

```bash
gh repo clone greatSumini/claw && pnpm i
# .env 새로 발급 (Discord·Gmail OAuth·GitHub PAT·Claude 토큰)
# ~/.claude/projects/ 와 data/ 는 머신별 생성됨
pnpm run migrate
pnpm build
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claw.plist
```

---

## 디렉터리 구조

```
src/
  server.ts               Express + 데몬 entry
  config.ts               env 파싱, 레포 레지스트리
  claude.ts               `claude --print` spawn wrapper
  codex.ts                Codex 대체 엔진 wrapper
  adapters/
    discord.ts            Gateway 리스너, thread 관리, 재시작 핸들러
    gmail.ts              4계정 폴링, 중요도 판정 위임
  orchestrator/
    router.ts             trivial/repo/unclear 분류기
    skill-detector.ts     SKILL.md 감지·선택·주입
    prompt.ts             systemAppend 빌더
    auto-analysis.ts      스킬 제안·메모리 점수 업데이트
    fact-extractor.ts     세션 완료 후 키워드 추출
  state/
    db.ts                 SQLite 초기화·마이그레이션
    sessions.ts           thread ↔ session 매핑
    memories.ts           Layer 2 메모리 CRUD
    memories-hybrid.ts    BM25+임베딩 하이브리드 검색
    events.ts             감사 로그·FTS5 검색
  scheduler/
    repo-sync.ts          주기적 git pull (유휴 30분 이상)
    dreaming.ts           밤 시간 메모리 decay
  dashboard/
    routes.ts             /dashboard 엔드포인트 (htmx)
skills/                   Claw 전용 스킬 (레포 무관)
scripts/
  gmail-auth.ts           Gmail OAuth refresh token 발급
data/                     SQLite DB (gitignored)
logs/                     pino 로그 (gitignored)
```
