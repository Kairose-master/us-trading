/**
 * Upbit 시세 브라우저 클라이언트 — 브라우저는 Upbit를 직접 부르지 않는다.
 * 시세·캔들은 백엔드(/api/backend/crypto/*)가 한 번 받아 공유하고(초당 8회 토큰
 * 버킷, 캔들 저장소), 여기서는 그 결과만 읽는다. 탭마다 Upbit를 두드려 429가 나던
 * 것이 "캔들을 못 불러온다"의 원인이었다.
 */

export const CRYPTO_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-SOL", "KRW-DOGE"]

export interface UpbitTickerLite {
  market: string
  priceKrw: number
  changePct: number
  high: number
  low: number
  volume24h: number
}

export interface CryptoCandle {
  t: string // YYYY-MM-DD
  o: number
  h: number
  l: number
  c: number
  v: number
}

export async function fetchTickers(markets: string[] = CRYPTO_MARKETS): Promise<UpbitTickerLite[]> {
  const res = await fetch("/api/backend/crypto/quotes", { cache: "no-store" })
  if (!res.ok) throw new Error(`시세 HTTP ${res.status}`)
  const data = (await res.json()) as Array<UpbitTickerLite & { valueKrw24h?: number }>
  const want = new Set(markets)
  return data.filter((t) => want.has(t.market)).map(({ market, priceKrw, changePct, high, low, volume24h }) => ({ market, priceKrw, changePct, high, low, volume24h }))
}

/** 일봉 n개 (시간 오름차순) — 200개/호출 페이지네이션 */
export async function fetchDayCandles(market: string, n: number): Promise<CryptoCandle[]> {
  // 브라우저가 Upbit를 직접 부르지 않는다 — 백엔드 일봉 저장소(레이트리밋·캐시·stale 폴백)를 통해
  const res = await fetch(`/api/backend/crypto/candles/${encodeURIComponent(market)}?days=${n}`)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = (await res.json()) as { error?: string; code?: string }; msg = j.code === "BACKEND_NOT_CONFIGURED" ? "백엔드 미연결 (BACKEND_TOKEN)" : (j.error ?? msg) } catch { /* noop */ }
    throw new Error(msg)
  }
  return (await res.json()) as CryptoCandle[]
}
