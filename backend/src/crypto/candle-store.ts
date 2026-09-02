import { logger } from "../core/logger.js";
import type { BtCandle } from "./backtest.js";
import { upbit, type UpbitCandle } from "./upbit.js";

/**
 * 일봉 저장소 — 프로세스 안의 단일 진실. 스캐너·진화·백필·랩/퀀트/크립토 페이지가 전부
 * 여기서 읽는다. 마켓당 한 번만 받고(single-flight), 다음 UTC 자정까지 캐시하며, 갱신에
 * 실패하면 마지막 성공분을 stale 표시로 돌려준다 — 빈 화면 대신 "언제 것인지 아는" 데이터.
 */
interface Entry { at: number; candles: BtCandle[]; n: number; stale: boolean; error: string | null }

const TTL_MS = 30 * 60_000; // 같은 날 안에서는 30분마다만 재확인 (마지막 봉이 갱신되므로)
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<BtCandle[]>>();

export function toBt(cs: UpbitCandle[]): BtCandle[] {
  return cs.map((c) => ({ t: c.candle_date_time_utc.slice(0, 10), o: c.opening_price, h: c.high_price, l: c.low_price, c: c.trade_price, v: c.candle_acc_trade_volume }));
}

export async function getDayCandles(market: string, n: number): Promise<BtCandle[]> {
  const e = store.get(market);
  if (e && e.n >= n && Date.now() - e.at < TTL_MS) return e.candles.slice(-n);
  const key = `${market}:${n}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const cs = toBt(await upbit.dayCandles(market, Math.max(n, e?.n ?? 0)));
      store.set(market, { at: Date.now(), candles: cs, n: Math.max(n, e?.n ?? 0), stale: false, error: null });
      return cs.slice(-n);
    } catch (err) {
      const msg = (err as Error).message;
      if (e) {
        store.set(market, { ...e, stale: true, error: msg });
        logger.warn("캔들 갱신 실패 — 마지막 성공분 사용 (stale)", { market, error: msg.slice(0, 120) });
        return e.candles.slice(-n);
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function candleStoreStatus() {
  const rows = [...store.entries()].map(([market, e]) => ({ market, days: e.candles.length, at: new Date(e.at).toISOString(), stale: e.stale, error: e.error, last: e.candles[e.candles.length - 1]?.t ?? null }));
  return { markets: rows.length, stale: rows.filter((r) => r.stale).length, rows };
}
