import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PipelineEngine, type PipelineContext } from "../pipeline/engine.js";
import type { ExecutionSignal } from "../pipeline/types.js";
import { NewsIngestor } from "../sentiment/news.js";
import { upbit, type UpbitTicker } from "./upbit.js";
import { config } from "../config.js";
import { supervisor } from "../core/supervisor.js";
import { controlPlane } from "../control/plane.js";
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

import { cryptoUniverse, MAJORS } from "./universe.js";
/** 메이저 5개 — 호환용. 실제 추적·거래 대상은 cryptoUniverse.markets() (메이저 ∪ 상위 30 ∪ 보유) */
export const CRYPTO_MARKETS = MAJORS;
const NEWS_SYMBOLS_MAX = 15;
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
const EQUITY_SNAPSHOT_MS = 5 * 60_000; // 5분 — 시간 단위로는 판단이 성기다 // 1시간마다 에쿼티 스냅샷

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
  private signalPathNoticeShown = false;
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
    this.news = new NewsIngestor({ queryFor: (s) => `${s} crypto`, mockMode: false, sourceId: "news-rss-crypto", market: "crypto" });
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

  /** 페이퍼 장부 초기화 — 포지션·주문·에쿼티 기록을 전부 지우고 시드에서 다시 시작한다. 실계좌와 무관(페이퍼 전용) */
  resetPaper(startKrw = PAPER_START_KRW): { startKrw: number; since: string; clearedOrders: number; clearedPositions: number } {
    const clearedOrders = this.orders.length, clearedPositions = this.paperPositions.size;
    this.paperCashKrw = startKrw;
    this.paperPositions = new Map();
    this.altPrices.clear();
    this.orders = [];
    this.orderSeq = 0;
    this.paperSince = new Date().toISOString();
    try { mkdirSync(dirname(EQUITY_FILE), { recursive: true }); writeFileSync(EQUITY_FILE, ""); } catch (e) { logger.warn("에쿼티 기록 초기화 실패", { error: (e as Error).message }); }
    this.saveState();
    this.snapshotEquity();
    logger.warn("페이퍼 장부 초기화", { startKrw, clearedOrders, clearedPositions });
    return { startKrw, since: this.paperSince, clearedOrders, clearedPositions };
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
    this.pipeline.start(cryptoUniverse.symbols());
    // 유니버스가 바뀌면 파이프라인 추적·뉴스 심볼도 따라간다 — 알트도 신호 엔진의 거래 대상이다
    cryptoUniverse.attachHeld(() => [...this.paperPositions.keys()].map((s) => `KRW-${s}`));
    // 뉴스 RSS는 마켓 15개까지 — 27개를 다 돌리면 Google News가 503을 낸다 (2026-09-03 로컬). 나머지 알트는 시세·호가·워커 데스크로 읽는다
    cryptoUniverse.on("change", (markets: string[]) => { for (const m of markets) this.pipeline.track(COIN_OF(m)); this.news.setSymbols(markets.slice(0, NEWS_SYMBOLS_MAX).map(COIN_OF)); });
    this.pipeline.on("signal", (sig: ExecutionSignal) => void this.onSignal(sig));
    // 파이프라인 포트폴리오 타깃 → 제어 평면 제안 (15분마다 한 번, 타깃이 있을 때만)
    let lastSignalProposal = 0;
    this.pipeline.on("snapshot", () => {
      if (Date.now() - lastSignalProposal < 15 * 60_000) return;
      const pt = this.pipeline.portfolioTargets.filter((t) => t.targetWeightPct > 0);
      if (pt.length === 0) return;
      lastSignalProposal = Date.now();
      const conf = pt.reduce((a, t) => a + Math.abs(t.alpha), 0) / pt.length;
      void controlPlane.propose({ engine: "signals", targets: pt.map((t) => ({ market: `KRW-${t.symbol}`, weightPct: +t.targetWeightPct.toFixed(2) })), confidence: Math.max(0, Math.min(1, conf)), evidence: `ensemble alpha → portfolio targets for ${pt.length} symbols · mean |alpha| ${conf.toFixed(2)}`, ref: "crypto pipeline" }).catch(() => undefined);
    });
    this.news.setSymbols(cryptoUniverse.symbols().slice(0, NEWS_SYMBOLS_MAX));
    this.news.on("news", (items) => this.pipeline.onNews(items));
    this.news.start();
    // 감독자 아래로: 실패는 백오프 재시도, 회복 시 놓친 구간의 1분봉을 실제로 받아 파이프라인에 재생한다
    supervisor.register({
      id: "upbit-tickers",
      name: "Upbit tickers + order book",
      market: "crypto",
      feedsNode: "tick-data",
      intervalMs: POLL_MS,
      slaMs: POLL_MS * 5,
      run: () => this.poll(),
      backfill: (since) => this.backfill(since),
    });
    this.timer = setInterval(() => undefined, 60_000); // start() 중복 호출 가드
    logger.info("크립토 데스크 기동 (Upbit 공개 API — 실데이터)", { universe: cryptoUniverse.markets().length, majors: MAJORS });
  }

  /** 놓친 구간의 1분봉을 받아 종가를 틱으로 재생 — 실제 과거 데이터, 라벨은 replay */
  private async backfill(sinceIso: string): Promise<{ rows: number; note: string }> {
    const since = Date.parse(sinceIso);
    const minutes = Math.min(200, Math.max(1, Math.ceil((Date.now() - since) / 60_000)));
    let rows = 0;
    const universe = cryptoUniverse.markets();
    for (const market of universe) {
      const candles = await upbit.minuteCandles(market, minutes);
      for (const c of candles) {
        // 캔들은 그 분의 시작 시각을 갖는다 — 장애 시작이 포함된 분봉부터 재생
        if (Date.parse(`${c.candle_date_time_utc}Z`) + 60_000 <= since) continue;
        this.pipeline.onTick({ symbol: COIN_OF(market), last: c.trade_price, bid: c.trade_price, ask: c.trade_price, bidSize: 0, askSize: 0, volume: Math.round(c.candle_acc_trade_volume) });
        rows++;
      }
    }
    return { rows, note: `${minutes} minute candles × ${universe.length} markets replayed as ticks (no order book — sizes 0)` };
  }

  private async poll(): Promise<{ rows: number }> {
    {
      // 기본 마켓 + 스캐너가 들고 온 알트 보유분 — 보유 중인 코인의 시세는
      // 반드시 추적해야 에쿼티가 정확하다
      // 유니버스 전체(메이저 ∪ 상위 30 ∪ 보유)의 시세와 호가 — 전부 파이프라인에 들어간다
      const watch = cryptoUniverse.markets();
      const [tickers, books] = await Promise.all([
        upbit.tickers(watch),
        upbit.orderbooks(watch),
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
      return { rows: tickers.length };
    }
  }

  /** 파이프라인 실행 신호 → (설정에 따라) 페이퍼/실주문 */
  private cooldown = new Map<string, number>();

  private async onSignal(sig: ExecutionSignal) {
    // 신호는 더 이상 장부를 직접 건드리지 않는다. 파이프라인 스냅샷이 15분마다 제어 평면에
    // "signals" 제안으로 올라가고, 협의회가 다른 제안 매니저의 동의가 있을 때만 집행한다
    // ("시그널만 보고 매수하지 않는다"). 이 경로는 실주문 모드에서도 닫혀 있다.
    if (!this.signalPathNoticeShown) { this.signalPathNoticeShown = true; logger.info("[desk] 신호 직접 집행 비활성 — 신호는 제어 평면 제안으로만 간다", { symbol: sig.symbol, tradeEnabled: this.tradeEnabled }); }
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
      markets: cryptoUniverse.markets(),
      equityKrw: Math.round(this.equityKrw()),
      cashKrw: Math.round(this.paperCashKrw),
      positions: [...this.paperPositions.entries()].map(([symbol, p]) => {
        const cur = this.lastTickers.get(`KRW-${symbol}`)?.trade_price ?? this.altPrices.get(`KRW-${symbol}`) ?? 0;
        // 평단은 반올림하지 않는다 — ₩0.005짜리 코인의 평단을 0으로 만들어 손익률이 깨졌다 (BONK avg 0)
        return { symbol, qty: p.qty, avgKrw: +p.avgKrw.toPrecision(6), curKrw: cur };
      }),
      orders: this.orders.slice(0, 100),
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
