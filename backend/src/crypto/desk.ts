import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
// 페이퍼 체결에도 실거래와 같은 비용을 부과한다 — 비용 없는 페이퍼 기록은 자기기만이다
const PAPER_FEE_PCT = 0.05; // 업비트 현물 편도
const PAPER_SLIP_PCT = 0.05; // 시장가 슬리피지 가정
// 영속화 — 재시작해도 페이퍼 실적이 이어져야 "라이브 기록"이 된다
const STATE_FILE = join(process.cwd(), "data", "crypto-paper.json");
const EQUITY_FILE = join(process.cwd(), "data", "crypto-paper-equity.jsonl");
const EQUITY_SNAPSHOT_MS = 60 * 60_000; // 1시간마다 에쿼티 스냅샷

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
  /** 체결에 부과된 수수료+슬리피지 (KRW) — 페이퍼도 실비용을 문다 */
  costKrw: number;
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
  /** 스캐너가 넘긴 알트 현재가 — 다음 폴링 전까지 에쿼티 계산의 폴백 (로테이션 직후 스냅샷이 보유분을 빠뜨리던 실측 버그) */
  private altPrices = new Map<string, number>();
  lastError: string | null = null;
  paperSince: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private equityTimer: NodeJS.Timeout | null = null;
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
    // paperPositions 키는 심볼("BTC") — 티커 키는 마켓("KRW-BTC")
    for (const [sym, p] of this.paperPositions) {
      const px = this.lastTickers.get(`KRW-${sym}`)?.trade_price ?? this.altPrices.get(`KRW-${sym}`) ?? 0;
      eq += p.qty * px;
    }
    return eq;
  }

  // ===== 페이퍼 장부 영속화 =====

  private loadState() {
    try {
      if (!existsSync(STATE_FILE)) return;
      const s = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as {
        cashKrw: number;
        positions: Array<[string, { qty: number; avgKrw: number }]>;
        orders: CryptoOrder[];
        orderSeq: number;
        since: string;
      };
      this.paperCashKrw = s.cashKrw;
      this.paperPositions = new Map(s.positions);
      this.orders = s.orders ?? [];
      this.orderSeq = s.orderSeq ?? 0;
      this.paperSince = s.since ?? null;
      logger.info("페이퍼 장부 복원", { cashKrw: Math.round(this.paperCashKrw), positions: this.paperPositions.size, orders: this.orders.length });
    } catch (e) {
      logger.warn("페이퍼 장부 복원 실패 — 새로 시작", { error: (e as Error).message });
    }
  }

  private saveState() {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      writeFileSync(
        STATE_FILE,
        JSON.stringify({
          cashKrw: this.paperCashKrw,
          positions: [...this.paperPositions.entries()],
          orders: this.orders.slice(0, 100),
          orderSeq: this.orderSeq,
          since: this.paperSince ?? new Date().toISOString(),
        }),
      );
    } catch (e) {
      logger.warn("페이퍼 장부 저장 실패", { error: (e as Error).message });
    }
  }

  private snapshotEquity() {
    if (this.lastTickers.size === 0) return;
    try {
      mkdirSync(dirname(EQUITY_FILE), { recursive: true });
      appendFileSync(
        EQUITY_FILE,
        JSON.stringify({ ts: new Date().toISOString(), equityKrw: Math.round(this.equityKrw()), cashKrw: Math.round(this.paperCashKrw), positions: this.paperPositions.size }) + "\n",
      );
    } catch (e) {
      logger.warn("에쿼티 스냅샷 실패", { error: (e as Error).message });
    }
  }

  /** 페이퍼 에쿼티 커브 (JSONL → 배열) */
  paperEquity(limit = 2000): Array<{ ts: string; equityKrw: number; cashKrw: number; positions: number }> {
    try {
      if (!existsSync(EQUITY_FILE)) return [];
      return readFileSync(EQUITY_FILE, "utf-8")
        .trim()
        .split("\n")
        .slice(-limit)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  start() {
    if (this.timer) return;
    this.loadState();
    if (!this.paperSince) {
      this.paperSince = new Date().toISOString();
      this.saveState();
    }
    this.equityTimer = setInterval(() => this.snapshotEquity(), EQUITY_SNAPSHOT_MS);
    this.equityTimer.unref();
    setTimeout(() => this.snapshotEquity(), 30_000).unref(); // 기동 직후 1회
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
      // 기본 마켓 + 스캐너가 들고 온 알트 보유분 — 보유 중인 코인의 시세는
      // 반드시 추적해야 에쿼티가 정확하다
      const held = [...this.paperPositions.keys()].map((s) => `KRW-${s}`);
      const watch = [...new Set([...CRYPTO_MARKETS, ...held])];
      const [tickers, books] = await Promise.all([
        upbit.tickers(watch),
        upbit.orderbooks(CRYPTO_MARKETS),
      ]);
      this.lastError = null;
      const bookOf = new Map(books.map((b) => [b.market, b.orderbook_units[0]]));
      for (const t of tickers) {
        this.lastTickers.set(t.market, t);
        if (!CRYPTO_MARKETS.includes(t.market)) continue; // 알트 보유분은 시세만 추적, 파이프라인엔 안 넣는다
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
    // 페이퍼 체결가 = 시세 ± 슬리피지, 수수료는 금액에 부과 (실거래와 같은 조건)
    const slip = PAPER_SLIP_PCT / 100;
    const fee = PAPER_FEE_PCT / 100;
    const execPrice = sig.side === "buy" ? price * (1 + slip) : price * (1 - slip);
    const grossKrw = volume * execPrice;
    const feeKrw = grossKrw * fee;
    const order: CryptoOrder = {
      id: `CRYPTO-${++this.orderSeq}-${now}`,
      market,
      side: sig.side,
      volume,
      priceKrw: +execPrice.toFixed(0),
      amountKrw: Math.round(grossKrw),
      costKrw: Math.round(feeKrw + Math.abs(execPrice - price) * volume),
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

    // 페이퍼 장부 갱신 (실주문이어도 미러 기록) — 슬리피지 반영 체결가 + 수수료 차감
    const pos = this.paperPositions.get(sig.symbol);
    if (sig.side === "buy") {
      this.paperCashKrw -= grossKrw + feeKrw;
      if (pos) {
        pos.avgKrw = (pos.avgKrw * pos.qty + execPrice * volume) / (pos.qty + volume);
        pos.qty += volume;
      } else {
        this.paperPositions.set(sig.symbol, { qty: volume, avgKrw: execPrice });
      }
    } else {
      this.paperCashKrw += grossKrw - feeKrw;
      if (pos) {
        pos.qty -= volume;
        if (pos.qty <= 1e-10) this.paperPositions.delete(sig.symbol);
      }
    }
    this.orders.unshift(order);
    if (this.orders.length > 100) this.orders.length = 100;
    this.saveState();
    this.snapshotEquity();
    this.pipeline.log(
      "auto-trade",
      `${market} ${sig.side.toUpperCase()} ${volume} (₩${order.amountKrw.toLocaleString()}) [${order.mode}] — ${sig.reason}`,
    );
    this.emit("order", order);
  }

  /**
   * 스캐너 로테이션 — 페이퍼 장부를 타깃 비중으로 맞춘다. **페이퍼 전용**:
   * 실주문 모드(CRYPTO_TRADE_ALLOW_REAL+키)가 켜져 있으면 거부한다 —
   * 스캐너 규칙이 페이퍼에서 기록을 증명하기 전에는 실돈에 손대지 않는다.
   * priceOf: 데스크가 추적하지 않는 알트 마켓의 현재가 (스캐너가 공급).
   */
  rotateTo(
    targets: Array<{ market: string; weightPct: number }>,
    priceOf: Map<string, number>,
    reason: string,
  ): { orders: CryptoOrder[]; skipped: string[]; error?: string } {
    if (config.CRYPTO_TRADE_ALLOW_REAL && upbit.hasKeys()) {
      return { orders: [], skipped: [], error: "스캐너 로테이션은 페이퍼 전용 — 실주문 모드에서는 거부한다 (페이퍼 기록으로 증명이 먼저)" };
    }
    for (const [m, px] of priceOf) if (px > 0) this.altPrices.set(m, px);
    const price = (market: string) => priceOf.get(market) ?? this.lastTickers.get(market)?.trade_price ?? 0;
    // 현재 에쿼티 (스캐너 가격 우선 — 데스크 미추적 알트 포함)
    let equity = this.paperCashKrw;
    for (const [sym, p] of this.paperPositions) {
      const px = price(`KRW-${sym}`);
      if (px > 0) equity += p.qty * px;
    }
    const slip = PAPER_SLIP_PCT / 100;
    const fee = PAPER_FEE_PCT / 100;
    const done: CryptoOrder[] = [];
    const skipped: string[] = [];
    const fill = (market: string, side: "buy" | "sell", amountKrw: number) => {
      const mid = price(market);
      if (mid <= 0) {
        skipped.push(`${market}: 현재가 없음`);
        return;
      }
      const execPrice = side === "buy" ? mid * (1 + slip) : mid * (1 - slip);
      const volume = +(amountKrw / execPrice).toFixed(8);
      if (volume <= 0) return;
      const grossKrw = volume * execPrice;
      const feeKrw = grossKrw * fee;
      const sym = COIN_OF(market);
      const pos = this.paperPositions.get(sym);
      if (side === "buy") {
        if (this.paperCashKrw < grossKrw + feeKrw) {
          skipped.push(`${market}: 현금 부족`);
          return;
        }
        this.paperCashKrw -= grossKrw + feeKrw;
        if (pos) {
          pos.avgKrw = (pos.avgKrw * pos.qty + execPrice * volume) / (pos.qty + volume);
          pos.qty += volume;
        } else this.paperPositions.set(sym, { qty: volume, avgKrw: execPrice });
      } else {
        if (!pos) return;
        const v = Math.min(volume, pos.qty);
        this.paperCashKrw += v * execPrice * (1 - fee);
        pos.qty -= v;
        if (pos.qty <= 1e-10) this.paperPositions.delete(sym);
      }
      const order: CryptoOrder = {
        id: `SCAN-${++this.orderSeq}-${Date.now()}`,
        market,
        side,
        volume,
        priceKrw: +execPrice.toFixed(0),
        amountKrw: Math.round(grossKrw),
        costKrw: Math.round(feeKrw + Math.abs(execPrice - mid) * volume),
        mode: "paper",
        reason,
        ts: new Date().toISOString(),
      };
      done.push(order);
      this.orders.unshift(order);
    };

    const targetOf = new Map(targets.map((t) => [t.market, t.weightPct]));
    // 1) 타깃에 없는 보유분 전량 매도
    for (const [sym, p] of [...this.paperPositions.entries()]) {
      const market = `KRW-${sym}`;
      if (!targetOf.has(market)) {
        const px = price(market);
        if (px > 0) fill(market, "sell", p.qty * px);
        else skipped.push(`${market}: 현재가 없음 — 보유 유지`);
      }
    }
    // 2) 타깃 비중으로 증감 (업비트 최소주문 ₩5,000 미만 차이는 무시)
    for (const t of targets) {
      const sym = COIN_OF(t.market);
      const px = price(t.market);
      if (px <= 0) {
        skipped.push(`${t.market}: 현재가 없음`);
        continue;
      }
      const cur = (this.paperPositions.get(sym)?.qty ?? 0) * px;
      const want = (t.weightPct / 100) * equity;
      const diff = want - cur;
      if (Math.abs(diff) < 5_000) continue;
      fill(t.market, diff > 0 ? "buy" : "sell", Math.abs(diff));
    }
    if (this.orders.length > 100) this.orders.length = 100;
    this.saveState();
    this.snapshotEquity();
    this.pipeline.log("scanner", `로테이션 적용 — 주문 ${done.length}건, 스킵 ${skipped.length}건 [paper] — ${reason}`);
    return { orders: done, skipped };
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
      paperSince: this.paperSince,
      paperStartKrw: PAPER_START_KRW,
      costs: { feePct: PAPER_FEE_PCT, slipPct: PAPER_SLIP_PCT },
      markets: CRYPTO_MARKETS,
      equityKrw: Math.round(this.equityKrw()),
      cashKrw: Math.round(this.paperCashKrw),
      positions: [...this.paperPositions.entries()].map(([symbol, p]) => {
        const cur = this.lastTickers.get(`KRW-${symbol}`)?.trade_price ?? this.altPrices.get(`KRW-${symbol}`) ?? 0;
        return { symbol, qty: p.qty, avgKrw: Math.round(p.avgKrw), curKrw: cur };
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
