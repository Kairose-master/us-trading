/**
 * Upbit 공개 API 브라우저 클라이언트 — 키 불필요, CORS `*` 라 프론트에서 직접 실데이터.
 * (백엔드 crypto/upbit.ts의 공개 슬라이스와 동일 엔드포인트)
 */

const BASE = "https://api.upbit.com/v1"

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

/** KRW 전 마켓 목록 → 24h 거래대금 상위 topN (스캐너 유니버스) */
export async function fetchTopKrwMarkets(topN: number): Promise<Array<{ market: string; koreanName: string; priceKrw: number; valueKrw24h: number; changePct: number }>> {
  const res = await fetch(`${BASE}/market/all?is_details=false`)
  if (!res.ok) throw new Error(`Upbit market/all HTTP ${res.status}`)
  const all = (await res.json()) as Array<{ market: string; korean_name: string }>
  const krw = all.filter((m) => m.market.startsWith("KRW-"))
  const nameOf = new Map(krw.map((m) => [m.market, m.korean_name]))
  const tickers: Array<{ market: string; trade_price: number; acc_trade_price_24h: number; signed_change_rate: number }> = []
  for (let i = 0; i < krw.length; i += 100) {
    const chunk = krw.slice(i, i + 100).map((m) => m.market)
    const r = await fetch(`${BASE}/ticker?markets=${encodeURIComponent(chunk.join(","))}`)
    if (!r.ok) throw new Error(`Upbit ticker HTTP ${r.status}`)
    tickers.push(...((await r.json()) as typeof tickers))
  }
  return tickers
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, topN)
    .map((t) => ({
      market: t.market,
      koreanName: nameOf.get(t.market) ?? t.market,
      priceKrw: t.trade_price,
      valueKrw24h: Math.round(t.acc_trade_price_24h),
      changePct: +(t.signed_change_rate * 100).toFixed(2),
    }))
}

export async function fetchTickers(markets: string[] = CRYPTO_MARKETS): Promise<UpbitTickerLite[]> {
  const res = await fetch(`${BASE}/ticker?markets=${encodeURIComponent(markets.join(","))}`)
  if (!res.ok) throw new Error(`Upbit ticker HTTP ${res.status}`)
  const data = (await res.json()) as Array<{
    market: string
    trade_price: number
    signed_change_rate: number
    high_price: number
    low_price: number
    acc_trade_volume_24h: number
  }>
  return data.map((t) => ({
    market: t.market,
    priceKrw: t.trade_price,
    changePct: +(t.signed_change_rate * 100).toFixed(2),
    high: t.high_price,
    low: t.low_price,
    volume24h: t.acc_trade_volume_24h,
  }))
}

/** 일봉 n개 (시간 오름차순) — 200개/호출 페이지네이션 */
export async function fetchDayCandles(market: string, n: number): Promise<CryptoCandle[]> {
  const out: CryptoCandle[] = []
  let to: string | null = null
  while (out.length < n) {
    const count = Math.min(200, n - out.length)
    const toParam: string = to ? `&to=${encodeURIComponent(to)}` : ""
    const res = await fetch(`${BASE}/candles/days?market=${market}&count=${count}${toParam}`)
    if (!res.ok) throw new Error(`Upbit candles HTTP ${res.status}`)
    const batch = (await res.json()) as Array<{
      candle_date_time_utc: string
      opening_price: number
      high_price: number
      low_price: number
      trade_price: number
      candle_acc_trade_volume: number
    }>
    if (batch.length === 0) break
    out.push(
      ...batch.map((c) => ({
        t: c.candle_date_time_utc.slice(0, 10),
        o: c.opening_price,
        h: c.high_price,
        l: c.low_price,
        c: c.trade_price,
        v: c.candle_acc_trade_volume,
      })),
    )
    to = batch[batch.length - 1].candle_date_time_utc
    if (batch.length < count) break
  }
  return out.reverse()
}
