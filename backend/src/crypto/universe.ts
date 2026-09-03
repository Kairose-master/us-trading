import { EventEmitter } from "node:events";
import { logger } from "../core/logger.js";
import { scannerServer } from "./scanner-server.js";

/**
 * 크립토 투자 유니버스 — "알트 스캐너"는 별개의 도구가 아니라 **모든 엔진이 거래하는
 * 자산 목록**을 만드는 층이다. 유니버스 = 메이저(BTC·ETH·XRP·SOL·DOGE) ∪ 24h 거래대금
 * 상위 30 KRW 마켓 ∪ 현재 보유분. 30분마다 스캔(공유 캔들 저장소)에서 갱신하고,
 * 데스크는 이 목록 전체의 시세·호가를 받아 파이프라인(신호 엔진)과 뉴스 감성에 넣는다.
 * 진화·오피스는 이미 같은 스캔 시리즈를 쓴다. 스캔의 랭킹(모멘텀/변동성·HMM·GARCH)은
 * 유니버스의 **자산 특성**으로 남고, 그 자체로 제안을 내지 않는다.
 */
export const MAJORS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-SOL", "KRW-DOGE"];
const REFRESH_MS = 30 * 60_000;

class CryptoUniverse extends EventEmitter {
  private list: string[] = [...MAJORS];
  private refreshedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private heldOf: () => string[] = () => [];

  attachHeld(fn: () => string[]) { this.heldOf = fn; }
  markets(): string[] { return [...new Set([...this.list, ...this.heldOf()])]; }
  symbols(): string[] { return this.markets().map((m) => m.replace("KRW-", "")); }
  status() { return { markets: this.markets(), majors: MAJORS, refreshedAt: this.refreshedAt, refreshMs: REFRESH_MS }; }

  async refresh(force = false): Promise<string[]> {
    try {
      const scan = await scannerServer.scan(force);
      const next = [...new Set([...MAJORS, ...scan.scores.map((s) => s.market)])];
      const added = next.filter((m) => !this.list.includes(m)), removed = this.list.filter((m) => !next.includes(m));
      this.list = next; this.refreshedAt = new Date().toISOString();
      if (added.length || removed.length) { logger.info("[universe] refreshed", { size: next.length, added: added.map((m) => m.slice(4)), removed: removed.map((m) => m.slice(4)) }); this.emit("change", this.markets()); }
    } catch (e) { logger.warn("[universe] refresh failed — keeping previous list", { size: this.list.length, error: (e as Error).message }); }
    return this.markets();
  }

  startAutoRefresh() {
    if (this.timer) return;
    setTimeout(() => void this.refresh(), 20_000).unref();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS); this.timer.unref();
    logger.info("[universe] auto refresh on", { everyMin: REFRESH_MS / 60_000, majors: MAJORS.length });
  }
}
export const cryptoUniverse = new CryptoUniverse();
