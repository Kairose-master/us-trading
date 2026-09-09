import { createHmac, createHash, randomUUID } from "node:crypto";
import { upbitKeys } from "../auth/credentials.js";
import { egressFetch } from "../core/egress.js";

/**
 * Upbit REST 클라이언트 — 의존성 zero.
 * 공개(시세/캔들/호가): 키 불필요, 항상 실데이터.
 * 개인(계좌/주문): JWT(HS256, query_hash=SHA512) — UPBIT_ACCESS_KEY/SECRET_KEY
 * 가 있어야 하고, 주문은 데스크가 거래 모드를 real로 무장(armReal)해야 나간다.
 * 개인 호출은 EXCHANGE_PROXY_URL이 있으면 고정 IP 프록시를 거친다(허용 IP 등록용,
 * src/core/egress.ts). 공개 호출은 프록시 한도를 아끼려 항상 직접 나간다.
 * 공개 레이트리밋(초당 10회/IP)을 넘지 않도록 폴링 주기는 데스크에서 관리.
 */

const BASE = "https://api.upbit.com/v1";
const TIMEOUT = 10_000;

export interface UpbitTicker {
  market: string; // "KRW-BTC"
  trade_price: number;
  prev_closing_price: number;
  change_price: number;
  signed_change_rate: number;
  acc_trade_volume_24h: number;
  acc_trade_price_24h: number;
  high_price: number;
  low_price: number;
  timestamp: number;
}

export interface UpbitOrderbookUnit {
  ask_price: number;
  bid_price: number;
  ask_size: number;
  bid_size: number;
}

export interface UpbitOrderbook {
  market: string;
  orderbook_units: UpbitOrderbookUnit[];
}

/** GET /v1/accounts 한 줄 — balance는 가용, locked는 미체결 주문에 묶인 양 */
export interface UpbitAccount {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  unit_currency: string;
}

/** POST /v1/orders · GET /v1/order 응답 (필요한 필드만) */
export interface UpbitOrderState {
  uuid: string;
  side: "bid" | "ask";
  ord_type: string;
  state: "wait" | "watch" | "done" | "cancel";
  market: string;
  volume: string | null;
  executed_volume: string;
  paid_fee: string;
  price: string | null;
  trades?: Array<{ price: string; volume: string; funds: string }>;
}

/**
 * 실주문 무장 플래그 — 데스크가 거래 모드를 real로 바꿀 때만 켠다 (UI 스위치).
 * placeOrder는 이 플래그 없이는 절대 나가지 않는다. 환경변수로는 켤 수 없다.
 */
let realArmed = false;
export function armReal(on: boolean) { realArmed = on; }
export function isRealArmed() { return realArmed; }

export interface UpbitCandle {
  market: string;
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number; // close
  candle_acc_trade_volume: number;
}

// 공개 API 재시도 — 429(레이트리밋)·5xx·타임아웃은 백오프 후 최대 3회.
// 호스팅(공유 IP·해외 리전)에서 캔들 요청 절반이 조용히 빠지던 것을 실측한 뒤 추가.
const RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 프로세스 전역 토큰버킷 — Upbit 공개 API는 IP당 초당 10회. 데스크 폴링·스캐너·진화·
// 백필·워커가 제각각 부르면 합이 넘어 429가 났고, 그게 "캔들을 못 불러오는" 원인이었다.
// 모든 공개 호출이 이 한 줄을 지난다 (초당 8회, 버스트 8).
const RATE_PER_SEC = 8;
let tokens = RATE_PER_SEC;
const waiters: Array<() => void> = [];
setInterval(() => { tokens = Math.min(RATE_PER_SEC, tokens + RATE_PER_SEC); while (tokens >= 1 && waiters.length) { tokens -= 1; waiters.shift()!(); } }, 1000).unref();
function acquire(): Promise<void> {
  if (tokens >= 1) { tokens -= 1; return Promise.resolve(); }
  return new Promise((r) => waiters.push(r));
}
export function upbitRateStatus() { return { perSec: RATE_PER_SEC, tokens, queued: waiters.length }; }

async function getJson<T>(path: string): Promise<T> {
  let lastErr: Error | null = null;
  await acquire();
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT) });
      if (res.ok) return (await res.json()) as T;
      const body = (await res.text()).slice(0, 200);
      lastErr = new Error(`Upbit ${path} → HTTP ${res.status}: ${body}`);
      if (res.status !== 429 && res.status < 500) throw lastErr; // 4xx(429 제외)는 재시도 무의미
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await sleep(Math.max(retryAfter * 1000, 400 * 2 ** attempt));
    } catch (e) {
      lastErr = e as Error;
      if (attempt === RETRIES) break;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr ?? new Error(`Upbit ${path} 실패`);
}

export const upbit = {
  hasKeys(): boolean {
    return upbitKeys() !== null;
  },

  // ===== 공개 =====

  /** 전체 마켓 목록 — KRW 마켓만 추리려면 filter(m => m.market.startsWith("KRW-")) */
  markets(): Promise<Array<{ market: string; korean_name: string; english_name: string }>> {
    return getJson(`/market/all?is_details=false`);
  },

  tickers(markets: string[]): Promise<UpbitTicker[]> {
    return getJson(`/ticker?markets=${encodeURIComponent(markets.join(","))}`);
  },

  orderbooks(markets: string[]): Promise<UpbitOrderbook[]> {
    return getJson(`/orderbook?markets=${encodeURIComponent(markets.join(","))}`);
  },

  /** 일봉 count개 (최신부터, 최대 200/호출 — n>200은 페이지네이션) */
  /** 1분봉 (최대 200개, 최신→과거로 오므로 오름차순으로 뒤집는다) — 감독자 백필용 */
  async minuteCandles(market: string, n: number): Promise<UpbitCandle[]> {
    const batch: UpbitCandle[] = await getJson(`/candles/minutes/1?market=${market}&count=${Math.min(200, Math.max(1, n))}`);
    return batch.reverse();
  },

  /** 특정 시각 직전 1분봉의 종가 — 벤치마크 기준 복원용. 그 분의 봉이 없으면(거래 없음) 그 앞 봉이 온다 */
  async priceAt(market: string, iso: string): Promise<number> {
    const to = new Date(Date.parse(iso) + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const batch: UpbitCandle[] = await getJson(`/candles/minutes/1?market=${market}&count=1&to=${encodeURIComponent(to)}`);
    return batch[0]?.trade_price ?? 0;
  },

  async dayCandles(market: string, n: number): Promise<UpbitCandle[]> {
    const out: UpbitCandle[] = [];
    let to: string | null = null;
    while (out.length < n) {
      const count = Math.min(200, n - out.length);
      const toParam: string = to ? `&to=${encodeURIComponent(to)}` : "";
      const batch: UpbitCandle[] = await getJson(`/candles/days?market=${market}&count=${count}${toParam}`);
      if (batch.length === 0) break;
      out.push(...batch);
      to = batch[batch.length - 1].candle_date_time_utc;
      if (batch.length < count) break;
    }
    // API는 최신→과거 순으로 준다 → 시간 오름차순으로 뒤집는다
    return out.reverse();
  },

  // ===== 개인 (JWT) =====

  /** Upbit 인증 JWT — HS256, 쿼리 파라미터는 SHA512 query_hash로 서명 */
  authToken(query?: string): string {
    const keys = upbitKeys();
    if (!keys) throw new Error("Upbit 키 미설정 — 환경변수 또는 설정 페이지 금고");
    const payload: Record<string, string> = {
      access_key: keys.accessKey,
      nonce: randomUUID(),
    };
    if (query) {
      payload.query_hash = createHash("sha512").update(query, "utf-8").digest("hex");
      payload.query_hash_alg = "SHA512";
    }
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = b64({ alg: "HS256", typ: "JWT" });
    const body = b64(payload);
    const sig = createHmac("sha256", keys.secretKey).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${sig}`;
  },

  async accounts(): Promise<UpbitAccount[]> {
    const res = await egressFetch("upbit", `${BASE}/accounts`, {
      headers: { Authorization: `Bearer ${this.authToken()}` },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Upbit /accounts → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as UpbitAccount[];
  },

  /** 주문 단건 조회 — 시장가 체결 확인용 (state: wait/watch/done/cancel) */
  async order(uuid: string): Promise<UpbitOrderState> {
    const query = `uuid=${encodeURIComponent(uuid)}`;
    const res = await egressFetch("upbit", `${BASE}/order?${query}`, {
      headers: { Authorization: `Bearer ${this.authToken(query)}` },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Upbit /order → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as UpbitOrderState;
  },

  /**
   * 실주문 — 데스크가 실주문 모드로 무장(armReal)했고 키가 있어야 나간다.
   * side: bid(매수)/ask(매도) · ord_type: price(시장가 매수, price=KRW금액),
   * market(시장가 매도, volume=수량), limit(지정가, 둘 다)
   */
  async placeOrder(p: {
    market: string;
    side: "bid" | "ask";
    ord_type: "limit" | "price" | "market";
    volume?: string;
    price?: string;
    identifier?: string;
  }): Promise<UpbitOrderState> {
    if (!realArmed) {
      throw new Error("실주문 차단 — 데스크 거래 모드가 real이 아니면 Upbit 주문은 나가지 않는다");
    }
    const params = new URLSearchParams();
    params.set("market", p.market);
    params.set("side", p.side);
    params.set("ord_type", p.ord_type);
    if (p.volume) params.set("volume", p.volume);
    if (p.price) params.set("price", p.price);
    if (p.identifier) params.set("identifier", p.identifier);
    const query = params.toString();
    const res = await egressFetch("upbit", `${BASE}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authToken(query)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(Object.fromEntries(params)),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Upbit 주문 실패 → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as UpbitOrderState;
  },
};
