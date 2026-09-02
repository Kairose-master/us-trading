import { upbit } from "./upbit.js";
import { cryptoDesk } from "./desk.js";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import {
  buildTargets,
  rotationBacktest,
  scoreCoin,
  SCANNER_DEFAULTS,
  type CoinScore,
  type RotationBacktestResult,
  type ScannerPortfolio,
} from "./scanner.js";
import type { BtCandle } from "./backtest.js";

/**
 * 스캐너 서버 측 — 유니버스 수집(레이트리밋 준수), 캐시, 데스크 로테이션 연결.
 * 순수 계산은 전부 scanner.ts에 있고 여기는 I/O와 상태만.
 *
 * 유니버스: KRW 전 마켓 → 24h 거래대금 상위 UNIVERSE_SIZE개.
 * 유동성 하위 코인을 애초에 제외하는 건 슬리피지 가정(0.05%)이 그나마
 * 성립하는 범위로 스캔을 제한하기 위해서다.
 */

const UNIVERSE_SIZE = 30;
const CANDLE_DAYS = 200;
const SCAN_TTL_MS = 10 * 60_000;
const BT_TTL_MS = 60 * 60_000;
// 동시 2 — 업비트 공개 레이트리밋(초당 10회/IP)을 공유 IP 호스팅에서도 안 넘기게
const CONCURRENCY = 2;
const AUTO_ROTATE_MS = 24 * 60 * 60_000;

export interface ScanResult {
  ts: string;
  krwMarkets: number;
  universe: number;
  scores: CoinScore[];
  portfolio: ScannerPortfolio;
  note: string;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

function toBt(cs: Awaited<ReturnType<typeof upbit.dayCandles>>): BtCandle[] {
  return cs.map((c) => ({
    t: c.candle_date_time_utc.slice(0, 10),
    o: c.opening_price,
    h: c.high_price,
    l: c.low_price,
    c: c.trade_price,
    v: c.candle_acc_trade_volume,
  }));
}

class ScannerServer {
  private scanCache: { at: number; data: ScanResult } | null = null;
  private btCache: { at: number; data: RotationBacktestResult } | null = null;
  private seriesCache: { at: number; data: Map<string, BtCandle[]>; valueOf: Map<string, number> } | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private running: Promise<ScanResult> | null = null;
  lastRotation: { ts: string; orders: number; skipped: string[] } | null = null;

  /** 유동성 상위 유니버스의 캔들 시리즈 (스캔·백테스트 공용, 캐시) */
  private async loadSeries(): Promise<{ series: Map<string, BtCandle[]>; valueOf: Map<string, number>; krwMarkets: number }> {
    if (this.seriesCache && Date.now() - this.seriesCache.at < SCAN_TTL_MS) {
      return { series: this.seriesCache.data, valueOf: this.seriesCache.valueOf, krwMarkets: this.seriesCache.data.size };
    }
    const all = await upbit.markets();
    const krw = all.filter((m) => m.market.startsWith("KRW-")).map((m) => m.market);
    // 티커는 100개씩 청크
    const tickers: Array<{ market: string; acc_trade_price_24h: number }> = [];
    for (let i = 0; i < krw.length; i += 100) {
      tickers.push(...(await upbit.tickers(krw.slice(i, i + 100))));
    }
    const top = tickers
      .slice()
      .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
      .slice(0, UNIVERSE_SIZE);
    const valueOf = new Map(top.map((t) => [t.market, Math.round(t.acc_trade_price_24h)]));
    const series = new Map<string, BtCandle[]>();
    await mapLimit(top, CONCURRENCY, async (t) => {
      try {
        const cs = await upbit.dayCandles(t.market, CANDLE_DAYS);
        if (cs.length >= 61) series.set(t.market, toBt(cs));
      } catch (e) {
        logger.warn("스캐너 캔들 수집 실패 — 해당 코인 제외", { market: t.market, error: (e as Error).message });
      }
    });
    this.seriesCache = { at: Date.now(), data: series, valueOf };
    return { series, valueOf, krwMarkets: krw.length };
  }

  async scan(force = false): Promise<ScanResult> {
    if (!force && this.scanCache && Date.now() - this.scanCache.at < SCAN_TTL_MS) return this.scanCache.data;
    if (this.running) return this.running;
    this.running = (async () => {
      const { series, valueOf, krwMarkets } = await this.loadSeries();
      const scores: CoinScore[] = [];
      for (const [market, cs] of series) {
        const sc = scoreCoin(market, cs, valueOf.get(market) ?? 0);
        if (sc) scores.push(sc);
      }
      scores.sort((a, b) => b.score - a.score);
      const portfolio = buildTargets(scores);
      if (scores.length < UNIVERSE_SIZE * 0.7) {
        logger.warn("스캐너 유니버스 결손 — 캔들 수집 실패가 많다", { scored: scores.length, wanted: UNIVERSE_SIZE });
      }
      const data: ScanResult = {
        ts: new Date().toISOString(),
        krwMarkets,
        universe: scores.length,
        scores,
        portfolio,
        note:
          `KRW ${krwMarkets}개 마켓 중 24h 거래대금 상위 ${UNIVERSE_SIZE}개만 스캔 (슬리피지 가정이 성립하는 범위). ` +
          `${scores.length}개 코인을 훑은 것 자체가 ${scores.length}번의 암묵적 검정 — 백테스트 탭의 다중검정 보정을 함께 볼 것.`,
      };
      this.scanCache = { at: Date.now(), data };
      return data;
    })();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async backtest(force = false): Promise<RotationBacktestResult | null> {
    if (!force && this.btCache && Date.now() - this.btCache.at < BT_TTL_MS) return this.btCache.data;
    const { series } = await this.loadSeries();
    const data = rotationBacktest(series);
    if (data) this.btCache = { at: Date.now(), data };
    return data;
  }

  /** 최신 스캔 타깃으로 페이퍼 장부 로테이션 (페이퍼 전용 — desk가 이중으로 거부) */
  async rotate(): Promise<{ ts: string; targets: ScannerPortfolio; orders: number; skipped: string[]; error?: string }> {
    const scan = await this.scan();
    const priceOf = new Map(scan.scores.map((s) => [s.market, s.priceKrw]));
    const r = cryptoDesk.rotateTo(scan.portfolio.targets, priceOf, `scanner 상위${scan.portfolio.targets.length} 로테이션 (${scan.ts.slice(0, 10)})`);
    if (!r.error) this.lastRotation = { ts: new Date().toISOString(), orders: r.orders.length, skipped: r.skipped };
    return { ts: scan.ts, targets: scan.portfolio, orders: r.orders.length, skipped: r.skipped, error: r.error };
  }

  /** CRYPTO_SCANNER=true일 때: 기동 5분 후 1회, 이후 24h마다 자동 로테이션 */
  startAutoLoop() {
    if (!config.CRYPTO_SCANNER || this.autoTimer) return;
    const run = async () => {
      try {
        const r = await this.rotate();
        logger.info("스캐너 자동 로테이션", { orders: r.orders, skipped: r.skipped.length, error: r.error ?? null });
      } catch (e) {
        logger.warn("스캐너 자동 로테이션 실패 — 다음 주기 재시도", { error: (e as Error).message });
      }
    };
    setTimeout(() => void run(), 5 * 60_000).unref();
    this.autoTimer = setInterval(() => void run(), AUTO_ROTATE_MS);
    this.autoTimer.unref();
    logger.info("스캐너 자동 로테이션 예약 (24h 주기, 페이퍼 전용)");
  }
}

export const scannerServer = new ScannerServer();
