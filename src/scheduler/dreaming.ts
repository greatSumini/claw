import type Database from 'better-sqlite3';
import { log } from '../log.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1시간마다 체크
const DREAM_WINDOW_HOURS = 4; // 연속 4시간 저활동 구간
const PROMOTE_THRESHOLD = 70; // 이 score 이상이면 Layer 2로 승격
const ARCHIVE_THRESHOLD = 20; // Layer 2에서 이 score 미만이면 archived
const DECAY_PER_DAY = 0.5; // 하루 비참조 시 score 감점

// 불용어 (한/영 공통 단기어)
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
  '이', '그', '저', '을', '를', '이', '가', '은', '는', '에', '의',
  '도', '로', '으로', '와', '과', '한', '하다', '하는', '있다', '없다',
]);

interface CandidateRow {
  id: number;
  scope: string;
  type: string;
  key: string;
  value: string;
  score: number;
  expires_at: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface HourCount {
  hour: number;
  cnt: number;
}

function extractTags(value: string): string {
  const words = value
    .split(/[\s\p{P}]+/u)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  // 중복 제거
  const unique = [...new Set(words)];
  return JSON.stringify(unique);
}

export class DreamingScheduler {
  private readonly db: Database.Database;
  private readonly notify: ((msg: string) => Promise<void>) | null;
  private timer: NodeJS.Timeout | null = null;
  private lastDreamDate: string | null = null; // 'YYYY-MM-DD'

  constructor(db: Database.Database, notify?: (msg: string) => Promise<void>) {
    this.db = db;
    this.notify = notify ?? null;
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.isInSleepWindow() && !this.alreadyDreamedToday()) {
        void this.dream();
      } else {
        log.debug('dreaming: skipped (not in sleep window or already dreamed today)');
      }
    }, CHECK_INTERVAL_MS);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    log.info({ checkIntervalMs: CHECK_INTERVAL_MS }, 'dreaming: scheduler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // 수면 시간대 감지
  private detectSleepWindow(): { startHour: number } {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const rows = this.db
      .prepare<[string], HourCount>(
        `SELECT CAST(strftime('%H', ts) AS INTEGER) AS hour, COUNT(*) AS cnt
         FROM events
         WHERE ts >= ?
         GROUP BY hour
         ORDER BY hour`,
      )
      .all(since);

    if (rows.length === 0) {
      return { startHour: 2 };
    }

    // 24시간 배열 (데이터 없는 시간대는 0)
    const hourCounts = new Array<number>(24).fill(0);
    for (const row of rows) {
      hourCounts[row.hour] = row.cnt;
    }

    // DREAM_WINDOW_HOURS 연속 구간 중 합계가 최소인 구간의 시작 시간
    let minSum = Infinity;
    let minStart = 2;

    for (let start = 0; start < 24; start++) {
      let sum = 0;
      for (let offset = 0; offset < DREAM_WINDOW_HOURS; offset++) {
        sum += hourCounts[(start + offset) % 24];
      }
      if (sum < minSum) {
        minSum = sum;
        minStart = start;
      }
    }

    return { startHour: minStart };
  }

  private isInSleepWindow(): boolean {
    const { startHour } = this.detectSleepWindow();
    const nowHour = new Date().getHours(); // local time
    const endHour = (startHour + DREAM_WINDOW_HOURS) % 24;
    if (startHour < endHour) return nowHour >= startHour && nowHour < endHour;
    return nowHour >= startHour || nowHour < endHour; // 자정 넘어가는 경우
  }

  private alreadyDreamedToday(): boolean {
    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
    return this.lastDreamDate === today;
  }

  private async dream(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    this.lastDreamDate = today;
    log.info('dreaming: started');

    const stats = { decayed: 0, promoted: 0, forgotten: 0, archived: 0 };

    try {
      const now = new Date().toISOString();

      // -----------------------------------------------------------------------
      // 1. Layer 1 처리
      // -----------------------------------------------------------------------

      const allCandidates = this.db
        .prepare<[], CandidateRow>(
          `SELECT id, scope, type, key, value, score, expires_at, source, created_at, updated_at
           FROM memories_candidate`,
        )
        .all();

      for (const candidate of allCandidates) {
        // score 감쇠
        const daysSinceUpdate =
          (Date.now() - new Date(candidate.updated_at).getTime()) / 86400000;
        const decay = daysSinceUpdate * DECAY_PER_DAY;
        const newScore = Math.max(0, candidate.score - decay);

        if (decay > 0) {
          this.db
            .prepare<[number, string, number]>(
              `UPDATE memories_candidate SET score = ?, updated_at = ? WHERE id = ?`,
            )
            .run(newScore, now, candidate.id);

          this.db
            .prepare<[number, string, string, number, string]>(
              `INSERT INTO memory_events (memory_id, layer, event_type, delta, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(candidate.id, 'candidate', 'decayed', -decay, now);

          stats.decayed++;
        }

        const isExpired = new Date(candidate.expires_at).getTime() <= Date.now();

        if (isExpired) {
          if (newScore >= PROMOTE_THRESHOLD) {
            // 만료됐지만 score 높음 → 승격
            this.promoteCandidate({ ...candidate, score: newScore });
            stats.promoted++;
          } else {
            // 만료 + 승격 기준 미달 → 무조건 망각 (zombie 방지)
            this.db
              .prepare<[number]>(`DELETE FROM memories_candidate WHERE id = ?`)
              .run(candidate.id);

            this.db
              .prepare<[number, string, string, number, string]>(
                `INSERT INTO memory_events (memory_id, layer, event_type, delta, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(candidate.id, 'candidate', 'forgotten', 0, now);

            stats.forgotten++;
          }
        } else {
          // 아직 만료 안된 것 중 score 높으면 조기 승격
          if (newScore >= PROMOTE_THRESHOLD) {
            this.promoteCandidate({ ...candidate, score: newScore });
            stats.promoted++;
          }
        }
      }

      // -----------------------------------------------------------------------
      // 2. Layer 2 처리
      // -----------------------------------------------------------------------

      interface MemoryRow {
        id: number;
        score: number;
        status: string;
        last_referenced_at: string | null;
        updated_at: string;
      }

      const allMemories = this.db
        .prepare<[], MemoryRow>(
          `SELECT id, score, status, last_referenced_at, updated_at
           FROM memories
           WHERE status != 'archived'`,
        )
        .all();

      for (const memory of allMemories) {
        const refBase = memory.last_referenced_at ?? memory.updated_at;
        const daysSinceRef = (Date.now() - new Date(refBase).getTime()) / 86400000;
        const decay = daysSinceRef * DECAY_PER_DAY;
        const newScore = Math.max(0, memory.score - decay);

        if (decay > 0) {
          this.db
            .prepare<[number, string, number]>(
              `UPDATE memories SET score = ?, updated_at = ? WHERE id = ?`,
            )
            .run(newScore, now, memory.id);

          this.db
            .prepare<[number, string, string, number, string]>(
              `INSERT INTO memory_events (memory_id, layer, event_type, delta, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(memory.id, 'memory', 'decayed', -decay, now);

          stats.decayed++;
        }

        if (newScore < ARCHIVE_THRESHOLD) {
          this.db
            .prepare<[string, number]>(
              `UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?`,
            )
            .run(now, memory.id);

          this.db
            .prepare<[number, string, string, number, string]>(
              `INSERT INTO memory_events (memory_id, layer, event_type, delta, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(memory.id, 'memory', 'archived', 0, now);

          stats.archived++;
        }
      }

      // -----------------------------------------------------------------------
      // 3. 통계 리포트
      // -----------------------------------------------------------------------

      log.info(stats, 'dreaming: completed');

      if (this.notify) {
        const lines = [
          `💭 **드리밍 완료** (${today})`,
          `• 감쇠: ${stats.decayed}개`,
          `• 승격 (Layer1→2): ${stats.promoted}개`,
          `• 망각: ${stats.forgotten}개`,
          `• 보관 처리: ${stats.archived}개`,
        ];
        await this.notify(lines.join('\n')).catch((err) =>
          log.error({ err }, 'dreaming: notify failed'),
        );
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'dreaming: failed');
    }
  }

  // Layer 1 → Layer 2 승격 (내부용)
  private promoteCandidate(candidate: CandidateRow): void {
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      // 1. tags 생성
      const tags = extractTags(candidate.value);

      // 2. memories 테이블에 INSERT, UNIQUE(scope, key) 충돌 시 UPDATE
      const insertResult = this.db
        .prepare<[string, string, string, string, string, number, string, string, string]>(
          `INSERT INTO memories
             (scope, type, key, value, tags, score, reference_count, status, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)
           ON CONFLICT(scope, key) DO UPDATE SET
             score = MAX(excluded.score, memories.score),
             value = excluded.value,
             tags = excluded.tags,
             updated_at = excluded.updated_at`,
        )
        .run(
          candidate.scope,
          candidate.type,
          candidate.key,
          candidate.value,
          tags,
          candidate.score,
          candidate.source,
          now,
          now,
        );

      const memoryId =
        insertResult.changes > 0 && insertResult.lastInsertRowid
          ? Number(insertResult.lastInsertRowid)
          : (() => {
              const row = this.db
                .prepare<[string, string], { id: number }>(
                  `SELECT id FROM memories WHERE scope = ? AND key = ?`,
                )
                .get(candidate.scope, candidate.key);
              return row?.id ?? null;
            })();

      // 3. memories_candidate에서 삭제
      this.db
        .prepare<[number]>(`DELETE FROM memories_candidate WHERE id = ?`)
        .run(candidate.id);

      // 4. memory_events에 promoted 로그
      this.db
        .prepare<[number | null, string, string, number, string]>(
          `INSERT INTO memory_events (memory_id, layer, event_type, delta, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(memoryId, 'candidate', 'promoted', candidate.score, now);
    });

    tx();
  }
}
