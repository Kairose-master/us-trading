import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../core/logger.js";
import { upbit } from "../crypto/upbit.js";
import { computeBenchmark, makeBase, type BenchmarkBase, type BenchmarkRead } from "./benchmark.js";

const FILE = join(process.cwd(), "data", "control", "benchmark.json");

/**
 * 벤치마크 기준의 보관·복원.
 *  - 장부 초기화: 그 순간의 실시세로 기준을 잡는다 (source: live)
 *  - 부팅: 파일의 since가 장부의 since와 다르면(파일이 없거나 예전 장부) 장부 since 시각의 1분봉으로 복원한다 (source: minute-candle)
 */
class BenchmarkStore {
  private base: BenchmarkBase | null = null;
  private last: BenchmarkRead | null = null;
  constructor() { this.load(); }
  private load() { try { if (existsSync(FILE)) this.base = JSON.parse(readFileSync(FILE, "utf-8")); } catch (e) { logger.warn("[benchmark] load failed", { error: (e as Error).message }); } }
  private save() { try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(this.base, null, 2)); } catch (e) { logger.warn("[benchmark] save failed", { error: (e as Error).message }); } }

  current(): BenchmarkRead | null { return this.last; }
  baseOf(): BenchmarkBase | null { return this.base; }

  /** 실시세로 지금을 기준으로 잡는다 (장부 초기화 직후) */
  rebaseLive(since: string, startEquityKrw: number, markets: string[], prices: Record<string, number>) {
    this.base = makeBase({ since, startEquityKrw, markets, prices, source: "live" });
    this.last = null;
    this.save();
    logger.info("[benchmark] rebased (live)", { since, basket: Object.keys(this.base.basket).length, btc: this.base.btcKrw });
  }

  /** 장부 since와 기준이 어긋나면 그 시각의 1분봉으로 기준을 복원한다 */
  async ensure(since: string, startEquityKrw: number, markets: string[]) {
    if (this.base && this.base.since === since) return;
    const prices: Record<string, number> = {};
    const want = [...new Set(["KRW-BTC", ...markets])];
    for (const m of want) {
      try { const px = await upbit.priceAt(m, since); if (px > 0) prices[m] = px; } catch (e) { logger.warn("[benchmark] priceAt failed", { market: m, error: (e as Error).message }); }
    }
    this.base = makeBase({ since, startEquityKrw, markets: want.filter((m) => m !== "KRW-BTC" || markets.includes(m)), prices, source: Object.keys(prices).length ? "minute-candle" : "unknown" });
    if (!this.base.btcKrw && prices["KRW-BTC"] > 0) this.base.btcKrw = prices["KRW-BTC"];
    this.last = null;
    this.save();
    logger.info("[benchmark] rebased (minute candles)", { since, basket: Object.keys(this.base.basket).length, btc: this.base.btcKrw });
  }

  /** 틱마다 — 실시세와 장부 에쿼티로 세 줄을 다시 계산한다 */
  mark(prices: Record<string, number>, equityKrw: number): BenchmarkRead | null {
    if (!this.base) return null;
    this.last = computeBenchmark(this.base, prices, equityKrw);
    return this.last;
  }
  /** 벤치마크가 현재가를 필요로 하는 시장 */
  markets(): string[] { return this.base ? [...new Set(["KRW-BTC", ...Object.keys(this.base.basket)])] : []; }
}

export const benchmarkStore = new BenchmarkStore();
