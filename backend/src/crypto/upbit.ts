import { createHmac, createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";

/**
 * Upbit REST 클라이언트 — 의존성 zero.
 * 공개(시세/캔들/호가): 키 불필요, 항상 실데이터.
 * 개인(계좌/주문): JWT(HS256, query_hash=SHA512) — UPBIT_ACCESS_KEY/SECRET_KEY
 * 가 있어야 하고, 주문은 CRYPTO_TRADE_ALLOW_REAL까지 켜져야 나간다.
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

export interface UpbitCandle {
  market: string;
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number; // close
  candle_acc_trade_volume: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`Upbit ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export const upbit = {
  hasKeys(): boolean {
    return Boolean(config.UPBIT_ACCESS_KEY && config.UPBIT_SECRET_KEY);
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
    if (!this.hasKeys()) throw new Error("UPBIT_ACCESS_KEY/SECRET_KEY 미설정");
    const payload: Record<string, string> = {
      access_key: config.UPBIT_ACCESS_KEY,
      nonce: randomUUID(),
    };
    if (query) {
      payload.query_hash = createHash("sha512").update(query, "utf-8").digest("hex");
      payload.query_hash_alg = "SHA512";
    }
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = b64({ alg: "HS256", typ: "JWT" });
    const body = b64(payload);
    const sig = createHmac("sha256", config.UPBIT_SECRET_KEY).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${sig}`;
  },

  async accounts(): Promise<Array<{ currency: string; balance: string; avg_buy_price: string }>> {
    const res = await fetch(`${BASE}/accounts`, {
      headers: { Authorization: `Bearer ${this.authToken()}` },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Upbit /accounts → HTTP ${res.status}`);
    return (await res.json()) as Array<{ currency: string; balance: string; avg_buy_price: string }>;
  },

  /**
   * 실주문 — CRYPTO_TRADE_ALLOW_REAL + 키가 전부 있어야 나간다.
   * side: bid(매수)/ask(매도) · ord_type: price(시장가 매수, price=KRW금액),
   * market(시장가 매도, volume=수량), limit(지정가, 둘 다)
   */
  async placeOrder(p: {
    market: string;
    side: "bid" | "ask";
    ord_type: "limit" | "price" | "market";
    volume?: string;
    price?: string;
  }): Promise<{ uuid: string }> {
    if (!config.CRYPTO_TRADE_ALLOW_REAL) {
      throw new Error("실주문 차단 — CRYPTO_TRADE_ALLOW_REAL=true 없이 Upbit 주문은 나가지 않는다");
    }
    const params = new URLSearchParams();
    params.set("market", p.market);
    params.set("side", p.side);
    params.set("ord_type", p.ord_type);
    if (p.volume) params.set("volume", p.volume);
    if (p.price) params.set("price", p.price);
    const query = params.toString();
    const res = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authToken(query)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(Object.fromEntries(params)),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Upbit 주문 실패 → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { uuid: string };
  },
};
