# claw

sumin의 개인 AI 에이전트 게이트웨이. Express 서버가 Discord/Gmail로부터 입력을 받아, **vanilla `claude` CLI를 headless로 호출**해서 작업을 처리하고 결과를 다시 채널로 돌려보낸다.

이전엔 nanoclaw로 운영했지만 컨테이너 격리 레이어의 마찰이 본인 사용 패턴엔 과해서, 같은 가치(메신저 게이트웨이 + 24/7 + 스케줄)만 호스트 프로세스로 직접 구현.

## 핵심 설계

```
Discord Gateway (discord.js)        Gmail polling (googleapis)
       │                                     │
       └──────────► orchestrator ◄───────────┘
                        │
                ┌───────┴───────┐
                │               │
            (a) trivial      (b)/(c) repo work
                │               │
                │       spawn `claude --print --resume <id>`
                │               │
                └───────► Discord post (thread-aware) + SQLite log
```

- **Repo registry** (config.ts): 어느 채널이 어느 repo에 잠겨있는지
- **Session 연속성**: Discord thread_id ↔ claude session_id 매핑 (sqlite)
- **메일 처리**: 10분 주기 폴링 → importance 판정 → vmc-context-hub 채널에 thread 생성
- **Dashboard**: htmx 기반 단순 페이지, port 3200

## 디렉터리

```
src/
  server.ts             # Express + 데몬 entry
  config.ts             # env 파싱, repo registry
  log.ts                # pino logger
  claude.ts             # `claude --print` spawn wrapper
  state/
    db.ts               # SQLite 초기화 + 마이그레이션
    sessions.ts         # thread_id → claude session_id
    mail.ts             # historyId, 발신자 정책
    events.ts           # 이벤트 로그 (대시보드용)
  adapters/
    discord.ts          # Gateway 리스너, thread 관리
    gmail.ts            # 4계정 폴링, importance 판정 위임
  orchestrator/
    router.ts           # 단답/위임 분기, 채널→repo 매핑
    importance.ts       # claude로 메일 중요도 판정
  dashboard/
    routes.ts           # /dashboard 엔드포인트
    views/              # htmx 템플릿
scripts/
  gmail-auth.ts         # 계정별 OAuth refresh token 발급
data/                   # SQLite + ignored
logs/                   # pino logs + ignored
```

## 셋업 (요약)

```bash
pnpm install
cp .env.example .env
# .env 채우기 (Discord, Gmail OAuth client, GitHub PAT, Claude OAuth token)
pnpm run migrate         # SQLite 초기화
tsx scripts/gmail-auth.ts greatsumini@gmail.com   # 계정별 한 번씩
pnpm run build
node dist/server.js      # 또는 launchd로 데몬화
```

## 데몬 (macOS)

`scripts/com.claw.plist` (생성됨) 참고. `launchctl bootstrap`으로 로그인 시 자동 시작.

## 다른 머신에서 적용 (요약)

이 repo는 코드, secrets는 `.env` (gitignored). 다른 머신:
1. `gh repo clone greatSumini/claw && pnpm i`
2. `.env` 새로 발급해 채움 (특히 `claude setup-token`, GitHub PAT, Discord/Gmail OAuth)
3. `~/.claude/projects/` 와 `data/` 는 머신별 — 새로 생성됨

## TODO 후순위

- 자동 답장 (지금은 draft만)
- 다른 채널 어댑터 (Slack/Telegram) — 핸들러 파일 추가만
- 메일 첨부 처리
- Claude API 비용 트래커 (대시보드에 일별 토큰 사용량)
