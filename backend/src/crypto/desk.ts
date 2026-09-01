import { EventEmitter } from "node:events";
import { PipelineEngine, type PipelineContext } from "../pipeline/engine.js";
import type { ExecutionSignal } from "../pipeline/types.js";
import { NewsIngestor } from "../sentiment/news.js";
import { upbit, type UpbitTicker } from "./upbit.js";
import { config } from "../config.js";
import { logger } from "../core/logger.js";

/**
 * 크립토 데스크 — 릴1 파이프라인의 업비트 인스턴스.
 * 시세/캔들은 공개 API라 MOCK_DATA와 무관하게 항상 실데이터로 돈다
 * (네트워크 실패 시 다음 주기 재시도, 수치를 지어내지 않는다).
 *
 * 주문 경로 3단:
 *   CRYPTO_TRADE=false            → 신호만 (기본)
 *   CRYPTO_TRADE=true             → 페이퍼 주문 기록 + 페이퍼 포지션 갱신
 *   + CRYPTO_TRADE_ALLOW_REAL + 키 → 실제 Upbit 주문 (upbit.placeOrder가 최종 관문)
 */

export const CRYPTO_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-SOL", "KRW-DOGE"];
/** 뉴스 검색용 — 마켓 코드에서 통화 심볼 */
const COIN_OF = (market: string) => market.split("-")[1];

const POLL_MS = 4_000;
const PAPER_START_KRW = 10_000_000; // 페이퍼 시드 (1천만원 — 가상)

export interface CryptoRiskLimits {
  maxOrderKrw: number;
  maxWeightPct: number;
  maxPositions: number;
}

export interface CryptoOrder {
  id: string;
  market: string;
  side: "buy" | "sell";
  volume: number;
  priceKrw: number;
  amountKrw: number;
  mode: "paper" | "real";
  reason: string;
  ts: string;
}

class CryptoDesk extends EventEmitter {
  pipeline: PipelineEngine;
  news: NewsIngestor;
  limits: CryptoRiskLimits = { maxOrderKrw: 500_000, maxWeightPct: 30, maxPositions: 4 };
  tradeEnabled = config.CRYPTO_TRADE;
  /** 페이퍼 장부 — 항상 유지 (실주문 모드여도 미러로 기록) */
  paperCashKrw = PAPER_START_KRW;
  paperPositions = new Map<string, { qty: number; avgKrw: number }>();
  orders: CryptoOrder[] = [];
  lastTickers = new Map<string, UpbitTicker>();
  lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private orderSeq = 0;

  constructor() {
    super();
    const ctx: PipelineContext = {
      positionOf: (symbol) => {
        const p = this.paperPositions.get(symbol);
        const t = this.lastTickers.get(symbol);
        return p && t ? { qty: p.qty, price: t.trade_price } : null;
      },
      positionsCount: () => this.paperPositions.size,
      equity: () => this.equityKrw(),
      maxWeightPct: () => this.limits.maxWeightPct,
      riskCheck: (p) => {
        if (p.amount > this.limits.maxOrderKrw) return `1회 최대 주문금액(₩${this.limits.maxOrderKrw.toLocaleString()}) 초과`;
        if (p.side === "buy" && p.resultingOpenPositions > this.limits.maxPositions)
          return `최대 동시 포지션 수(${this.limits.maxPositions}) 초과`;
        if (p.side === "buy" && p.resultingSymbolWeightPct > this.limits.maxWeightPct)
          return `마켓당 최대 비중(${this.limits.maxWeightPct}%) 초과`;
        return null;
      },
    };
    this.pipeline = new PipelineEngine(ctx);
    this.news = new NewsIngestor({ queryFor: (s) => `${s} crypto`, mockMode: false });
  }

  equityKrw(): number {
    let eq = this.paperCashKrw;
    for (const [market, p] of this.paperPositions) {
      const t = this.lastTickers.get(market);
      if (t) eq += p.qty * t.trade_price;
    }
    return eq;
  }

  start() {
    if (this.timer) return;
    this.pipeline.start(CRYPTO_MARKETS.map(COIN_OF));
    this.pipeline.on("signal", (sig: ExecutionSignal) => void this.onSignal(sig));
    this.news.setSymbols(CRYPTO_MARKETS.map(COIN_OF));
    this.news.on("news", (items) => this.pipeline.onNews(items));
    this.news.start();
    const loop = () => void this.poll();
    this.timer = setInterval(loop, POLL_MS);
    this.timer.unref();
    void this.poll();
    logger.info("크립토 데스크 기동 (Upbit 공개 API — 실데이터)", { markets: CRYPTO_MARKETS });
  }

  private async poll() {
    try {
      const [tickers, books] = await Promise.all([
        upbit.tickers(CRYPTO_MARKETS),
        upbit.orderbooks(CRYPTO_MARKETS),
      ]);
      this.lastError = null;
      const bookOf = new Map(books.map((b) => [b.market, b.orderbook_units[0]]));
      for (const t of tickers) {
        this.lastTickers.set(t.market, t);
        const top = bookOf.get(t.market);
        // 파이프라인 심볼은 통화 코드(BTC)로 — 뉴스/감성 심볼과 일치시킨다
        this.pipeline.onTick({
          symbol: COIN_OF(t.market),
          last: t.trade_price,
          bid: top?.bid_price ?? t.trade_price,
          ask: top?.ask_price ?? t.trade_price,
          bidSize: top?.bid_size ?? 0,
          askSize: top?.ask_size ?? 0,
          volume: Math.round(t.acc_trade_volume_24h),
        });
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      logger.warn("Upbit 폴링 실패 — 다음 주기 재시도", { error: this.lastError });
    }
  }

  /** 파이프라인 실행 신호 → (설정에 따라) 페이퍼/실주문 */
  private cooldown = new Map<string, number>();

  private async onSignal(sig: ExecutionSignal) {
    if (!this.tradeEnabled || sig.blocked) return;
    const market = `KRW-${sig.symbol}`;
    const t = this.lastTickers.get(market);
    if (!t) return;
    const now = Date.now();
    if (now - (this.cooldown.get(market) ?? 0) < 5 * 60_000) return;
    this.cooldown.set(market, now);

    const budget = Math.min((sig.strengthPct / 100) * this.equityKrw(), this.limits.maxOrderKrw);
    const price = t.trade_price;
    let volume: number;
    if (sig.side === "sell") {
      const pos = this.paperPositions.get(sig.symbol);
      if (!pos) return; // 없는 코인은 팔지 않는다
      volume = Math.min(pos.qty, budget / price);
    } else {
      volume = budget / price;
      if (volume * price < 5_000) return; // Upbit 최소 주문 미만
    }
    volume = +volume.toFixed(8);

    const realMode = config.CRYPTO_TRADE_ALLOW_REAL && upbit.hasKeys();
    const order: CryptoOrder = {
      id: `CRYPTO-${++this.orderSeq}-${now}`,
      market,
      side: sig.side,
      volume,
      priceKrw: price,
      amountKrw: Math.round(volume * price),
      mode: realMode ? "real" : "paper",
      reason: sig.reason,
      ts: new Date().toISOString(),
    };

    if (realMode) {
      try {
        const out = await upbit.placeOrder(
          sig.side === "buy"
            ? { market, side: "bid", ord_type: "price", price: String(Math.round(volume * price)) }
            : { market, side: "ask", ord_type: "market", volume: String(volume) },
        );
        order.id = out.uuid;
      } catch (e) {
        this.pipeline.log("auto-trade", `${market} 실주문 실패 — ${(e as Error).message}`);
        return;
      }
    }

    // 페이퍼 장부 갱신 (실주문이어도 미러 기록)
    const pos = this.paperPositions.get(sig.symbol);
    if (sig.side === "buy") {
      this.paperCashKrw -= volume * price;
      if (pos) {
        pos.avgKrw = (pos.avgKrw * pos.qty + price * volume) / (pos.qty + volume);
        pos.qty += volume;
      } else {
        this.paperPositions.set(sig.symbol, { qty: volume, avgKrw: price });
      }
    } else {
      this.paperCashKrw += volume * price;
      if (pos) {
        pos.qty -= volume;
        if (pos.qty <= 1e-10) this.paperPositions.delete(sig.symbol);
      }
    }
    this.orders.unshift(order);
    if (this.orders.length > 100) this.orders.length = 100;
    this.pipeline.log(
      "auto-trade",
      `${market} ${sig.side.toUpperCase()} ${volume} (₩${order.amountKrw.toLocaleString()}) [${order.mode}] — ${sig.reason}`,
    );
    this.emit("order", order);
  }

  setTrade(enabled: boolean): string | null {
    if (enabled && config.CRYPTO_TRADE_ALLOW_REAL && !upbit.hasKeys()) {
      return "CRYPTO_TRADE_ALLOW_REAL=true인데 Upbit 키가 없습니다 — 키를 넣거나 플래그를 내리세요";
    }
    this.tradeEnabled = enabled;
    this.pipeline.log("auto-trade", enabled ? `크립토 자동매매 ON (${config.CRYPTO_TRADE_ALLOW_REAL && upbit.hasKeys() ? "실주문" : "페이퍼"})` : "크립토 자동매매 OFF");
    return null;
  }

  status() {
    return {
      tradeEnabled: this.tradeEnabled,
      mode: config.CRYPTO_TRADE_ALLOW_REAL && upbit.hasKeys() ? "real" : "paper",
      hasKeys: upbit.hasKeys(),
      markets: CRYPTO_MARKETS,
      equityKrw: Math.round(this.equityKrw()),
      cashKrw: Math.round(this.paperCashKrw),
      positions: [...this.paperPositions.entries()].map(([symbol, p]) => {
        const t = this.lastTickers.get(`KRW-${symbol}`);
        return { symbol, qty: p.qty, avgKrw: Math.round(p.avgKrw), curKrw: t?.trade_price ?? 0 };
      }),
      orders: this.orders.slice(0, 20),
      lastError: this.lastError,
    };
  }

  quotes() {
    return [...this.lastTickers.values()].map((t) => ({
      market: t.market,
      priceKrw: t.trade_price,
      changePct: +(t.signed_change_rate * 100).toFixed(2),
      high: t.high_price,
      low: t.low_price,
      volume24h: t.acc_trade_volume_24h,
      valueKrw24h: Math.round(t.acc_trade_price_24h),
    }));
  }
}

export const cryptoDesk = new CryptoDesk();
