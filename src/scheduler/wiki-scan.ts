import type { AppConfig } from '../config.js';
import { log } from '../log.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30분마다 체크
const SCAN_HOUR_KST = 9; // 오전 9시(KST)에 실행

export class WikiScanScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastScanDate: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly triggerScan: () => Promise<void>,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.check();
    }, CHECK_INTERVAL_MS);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    if (!this.config.wikiChannelId) return;

    // KST = UTC+9
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const dateStr = nowKst.toISOString().slice(0, 10);
    const hour = nowKst.getUTCHours();

    if (this.lastScanDate === dateStr) {
      log.debug('wiki-scan: already ran today, skipping');
      return;
    }

    if (hour < SCAN_HOUR_KST || hour >= SCAN_HOUR_KST + 1) {
      log.debug({ hour }, 'wiki-scan: not in scan window, skipping');
      return;
    }

    this.lastScanDate = dateStr;
    log.info({ date: dateStr }, 'wiki-scan: running daily scan');
    try {
      await this.triggerScan();
    } catch (err) {
      log.error({ err: (err as Error).message }, 'wiki-scan: scan failed');
    }
  }
}
