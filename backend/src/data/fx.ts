import { logger } from "../core/logger.js";

/**
 * USD/KRW 실환율 — Yahoo Finance "KRW=X" (키 없음, 지연). 1시간 캐시.
 * 대시보드가 크립토(₩)와 미국(＄) 장부를 한 숫자로 합칠 때 쓴다.
 * 못 받으면 0을 돌려주고 화면은 "환율 미수신"으로 정직하게 보여준다 — 고정값 대체 없음.
 */
const TTL_MS = 60 * 60_000;
let cache: { rate: number; ts: string } | null = null;
let inflight: Promise<{ rate: number; ts: string }> | null = null;

export async function usdKrw(): Promise<{ rate: number; ts: string; source: string }> {
  if (cache && Date.now() - Date.parse(cache.ts) < TTL_MS) return { ...cache, source: "yahoo:KRW=X" };
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/KRW%3DX?range=1d&interval=1h", {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
        const rate = data.chart?.result?.[0]?.meta?.regularMarketPrice ?? 0;
        if (!(rate > 0)) throw new Error("no regularMarketPrice");
        cache = { rate: +rate.toFixed(2), ts: new Date().toISOString() };
        return cache;
      } catch (e) {
        logger.warn("USD/KRW 환율 조회 실패", { error: (e as Error).message });
        return cache ?? { rate: 0, ts: new Date().toISOString() };
      } finally {
        inflight = null;
      }
    })();
  }
  const r = await inflight;
  return { ...r, source: "yahoo:KRW=X" };
}
