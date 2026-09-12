import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PipelineEngine, type PipelineContext } from "../pipeline/engine.js";
import type { ExecutionSignal } from "../pipeline/types.js";
import { NewsIngestor } from "../sentiment/news.js";
import { armReal, upbit, type UpbitTicker } from "./upbit.js";
import { live, liveEquityKrw, planRotation, flowUntil, type LiveAccount, type LiveFlow } from "./live.js";
import { applyCooldown, DEFAULT_EXIT_RULES, evaluateExits, validateExitRules, type ExitAction, type ExitRules, type ExitTrack } from "./exits.js";
import { riskManager } from "../risk/riskManager.js";
import { config } from "../config.js";
import { supervisor } from "../core/supervisor.js";
import { controlPlane } from "../control/plane.js";
import { logger } from "../core/logger.js";

/**
 * 크립토 데스크 — 릴1 파이프라인의 업비트 인스턴스.
 * 시세/캔들은 공개 API라 MOCK_DATA와 무관하게 항상 실데이터로 돈다
 * (네트워크 실패 시 다음 주기 재시도, 수치를 지어내지 않는다).
 *
 * 거래 모드(UI 스위치, data/crypto-mode.json에 영속):
 *   paper (기본) → 제어 평면 결정이 페이퍼 장부만 움직인다
 *   real         → 같은 결정이 Upbit 실계좌로 나간다 (live.ts). owner가 설정 화면에서
 *                  "REAL"을 타이핑해 켠다. 켜는 순간 계좌 동기화로 키·허용 IP를 검증한다.
 * 환경변수 CRYPTO_TRADE_ALLOW_REAL은 모드 파일이 없을 때의 부팅 기본값일 뿐이다.
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
// 실계좌 — 모드 스위치와 실주문 기록은 페이퍼와 별도 파일 (페이퍼 기록을 오염시키지 않는다)
const MODE_FILE = join(process.cwd(), "data", "crypto-mode.json");
const LIVE_FILE = join(process.cwd(), "data", "crypto-live.json");
const LIVE_EQUITY_FILE = join(process.cwd(), "data", "crypto-live-equity.jsonl");
const LIVE_SYNC_MS = 60_000; // 실모드 계좌 재동기화 주기
// 청산 규칙·추적 상태 — 페이퍼/실모드 공통 (규칙은 설정 페이지, 추적은 데스크가 갱신)
const EXITS_FILE = join(process.cwd(), "data", "crypto-exits.json");
const EXIT_CHECK_MS = 10_000; // 시세 폴링(4초)마다 다 돌릴 필요는 없다
const EXIT_LOG_MAX = 50;

export type TradingMode = "paper" | "real";
const EQUITY_SNAPSHOT_MS = 5 * 60_000; // 5분 — 시간 단위로는 판단이 성기다 // 1시간마다 에쿼티 스냅샷

export interface CryptoRiskLimits {
  maxOrderKrw: number;
  maxWeightPct: number;
  maxPositions: number;
}

/** 청산 실행 기록 — 화면의 "왜 팔았나" */
export interface ExitEvent {
  ts: string;
  mode: TradingMode;
  market: string;
  kind: ExitAction["kind"];
  sellPct: number;
  volume: number;
  pnlPct: number;
  reason: string;
  /** 체결 주문 id — 실패면 null, error에 사유 */
  orderId: string | null;
  error: string | null;
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
  /** 거래 모드 — UI 스위치. real이면 rotateTo가 실계좌로 나간다 */
  mode: TradingMode = "paper";
  modeSince: string | null = null;
  modeBy: string | null = null;
  /** 실계좌 스냅샷 (real 모드에서 60초마다 + 집행 직후 동기화) */
  liveAccount: LiveAccount | null = null;
  liveError: string | null = null;
  /** 실모드 시작 시점의 에쿼티 — 실모드 드로다운·수익률 기준 */
  liveStartKrw: number | null = null;
  liveSince: string | null = null;
  /**
   * 실모드 시작 이후 KRW 입출금 — 손익·드로다운 기준을 옮긴다. 출금은 손실이 아니다
   * (실측: ₩523,998 출금이 "실모드 시작 이후 손익 −₩523,998"로 찍히고 드로다운 거부까지 걸렸다).
   */
  liveFlow: LiveFlow | null = null;
  liveFlowError: string | null = null;
  /** 청산 규칙(손절·트레일링·익절·지지 소멸) — 협의회와 별개로 시세 폴링마다 검사 */
  exitRules: ExitRules = { ...DEFAULT_EXIT_RULES };
  exitTracks = new Map<string, ExitTrack>();
  /** 청산 후 재진입 금지 — 심볼 → 해제 시각 */
  exitCooldown = new Map<string, string>();
  exitLog: ExitEvent[] = [];
  private exitBusy = false;
  private lastExitCheck = 0;
  private liveTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private equityTimer: NodeJS.Timeout | null = null;
  private orderSeq = 0;

  constructor() {
    super();
    const ctx: PipelineContext = {
      positionOf: (symbol) => {
        const p = this.ledger().positions.get(symbol);
        const t = this.lastTickers.get(symbol);
        return p && t ? { qty: p.qty, price: t.trade_price } : null;
      },
      positionsCount: () => this.ledger().positions.size,
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

  private priceOf(market: string): number {
    return this.lastTickers.get(market)?.trade_price ?? this.altPrices.get(market) ?? 0;
  }

  /** 현재 모드의 장부 — 파이프라인·유니버스·상태는 전부 이걸 본다 */
  ledger(): { cashKrw: number; positions: Map<string, { qty: number; avgKrw: number }> } {
    if (this.mode === "real") return { cashKrw: this.liveAccount?.cashKrw ?? 0, positions: this.liveAccount?.positions ?? new Map() };
    return { cashKrw: this.paperCashKrw, positions: this.paperPositions };
  }

  equityKrw(): number {
    if (this.mode === "real") return this.liveAccount ? liveEquityKrw(this.liveAccount, (m) => this.priceOf(m)) : 0;
    let eq = this.paperCashKrw;
    // paperPositions 키는 심볼("BTC") — 티커 키는 마켓("KRW-BTC")
    for (const [sym, p] of this.paperPositions) eq += p.qty * this.priceOf(`KRW-${sym}`);
    return eq;
  }

  // ===== 거래 모드 (UI 스위치) =====

  private loadMode() {
    try {
      if (existsSync(MODE_FILE)) {
        const m = JSON.parse(readFileSync(MODE_FILE, "utf-8")) as { mode: TradingMode; since: string; by: string };
        this.mode = m.mode === "real" ? "real" : "paper"; this.modeSince = m.since ?? null; this.modeBy = m.by ?? null;
      } else if (config.CRYPTO_TRADE_ALLOW_REAL && upbit.hasKeys()) {
        // 모드 파일이 없을 때만 env가 부팅 기본값 — 이후로는 UI 스위치가 진실
        this.mode = "real"; this.modeSince = new Date().toISOString(); this.modeBy = "env:CRYPTO_TRADE_ALLOW_REAL";
      }
      if (existsSync(LIVE_FILE)) {
        const l = JSON.parse(readFileSync(LIVE_FILE, "utf-8")) as { startKrw: number | null; since: string | null };
        this.liveStartKrw = l.startKrw ?? null; this.liveSince = l.since ?? null;
      }
    } catch (e) {
      logger.warn("거래 모드 복원 실패 — paper로", { error: (e as Error).message });
      this.mode = "paper";
    }
    armReal(this.mode === "real");
    if (this.mode === "real") logger.warn("⚠️ 실주문 모드로 기동 — 제어 평면 결정이 Upbit 실계좌로 나간다", { since: this.modeSince, by: this.modeBy });
    controlPlane.useMode(this.mode, "boot");
  }

  private saveMode() {
    try {
      mkdirSync(dirname(MODE_FILE), { recursive: true });
      writeFileSync(MODE_FILE, JSON.stringify({ mode: this.mode, since: this.modeSince, by: this.modeBy }));
      writeFileSync(LIVE_FILE, JSON.stringify({ startKrw: this.liveStartKrw, since: this.liveSince }));
    } catch (e) {
      logger.warn("거래 모드 저장 실패", { error: (e as Error).message });
    }
  }

  /** 실계좌 동기화 — 키·허용 IP가 틀리면 여기서 바로 드러난다 */
  async syncLive(): Promise<LiveAccount> {
    try {
      this.liveAccount = await live.sync();
      this.liveError = null;
      return this.liveAccount;
    } catch (e) {
      this.liveError = (e as Error).message;
      logger.error("[live] 계좌 동기화 실패", { error: this.liveError });
      throw e;
    }
  }

  /** 실모드 시작 이후 KRW 입출금 동기화 — 계좌 동기화와 분리해 실패해도 잔고는 살아 있게 */
  async syncLiveFlow(): Promise<LiveFlow | null> {
    if (!this.liveSince) return null;
    try {
      const prev = this.liveFlow?.netKrw ?? 0;
      this.liveFlow = await live.flows(this.liveSince);
      this.liveFlowError = null;
      if (this.liveFlow.netKrw !== prev) logger.info("[live] 입출금 반영", { depositKrw: this.liveFlow.depositKrw, withdrawKrw: this.liveFlow.withdrawKrw, netKrw: this.liveFlow.netKrw, rows: this.liveFlow.rows.length });
      return this.liveFlow;
    } catch (e) {
      this.liveFlowError = (e as Error).message;
      logger.warn("[live] 입출금 조회 실패 — 마지막 값 유지", { error: this.liveFlowError });
      return this.liveFlow;
    }
  }

  /** 실모드 손익 기준 = 시작 에쿼티 + 그 이후 순입금. paper면 시드 그대로 */
  baseKrw(): number {
    if (this.mode !== "real") return PAPER_START_KRW;
    return (this.liveStartKrw ?? 0) + (this.liveFlow?.netKrw ?? 0);
  }

  /** 입출금 보정 에쿼티 — 스냅샷(ts)과 현재를 같은 기준에서 비교하려고 그 시점까지의 순입금을 뺀다 */
  flowAdjustedKrw(equityKrw: number, tsIso: string): number {
    if (this.mode !== "real") return equityKrw;
    return equityKrw - flowUntil(this.liveFlow, tsIso);
  }

  /** 보유 알트의 현재가를 티커로 채운다 — 데스크 유니버스 밖 코인도 에쿼티에 들어가야 한다 */
  private async refreshHeldPrices() {
    const missing = [...this.ledger().positions.keys()].map((s) => `KRW-${s}`).filter((m) => !this.lastTickers.has(m));
    if (!missing.length) return;
    try { for (const t of await upbit.tickers(missing)) if (t.trade_price > 0) this.altPrices.set(t.market, t.trade_price); } catch { /* 다음 주기 */ }
  }

  private startLiveLoop() {
    if (this.liveTimer) return;
    const tick = async () => { try { await this.syncLive(); await this.refreshHeldPrices(); } catch { /* liveError에 남음 */ } await this.syncLiveFlow(); };
    void tick();
    this.liveTimer = setInterval(() => void tick(), LIVE_SYNC_MS);
    this.liveTimer.unref();
  }

  private stopLiveLoop() {
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.liveTimer = null;
  }

  /**
   * 거래 모드 전환 — owner가 UI에서. real로 갈 때는 계좌 동기화가 성공해야 바뀐다
   * (키 없음·허용 IP 불일치·권한 부족이 전부 여기서 걸린다). 실패하면 모드는 그대로.
   */
  async setMode(mode: TradingMode, by: string): Promise<{ error?: string; account?: LiveAccount }> {
    if (mode === this.mode) return {};
    if (mode === "real") {
      if (!upbit.hasKeys()) return { error: "Upbit 키가 없습니다 — 설정 페이지 금고 또는 환경변수에 넣으세요" };
      if (riskManager.killSwitchActive) return { error: "킬스위치가 켜져 있습니다 — 해제 후 전환" };
      let account: LiveAccount;
      try { account = await this.syncLive(); } catch (e) { return { error: `Upbit 계좌 조회 실패 — 키/허용 IP/권한 확인: ${(e as Error).message}` }; }
      await this.refreshHeldPrices();
      this.mode = "real"; this.modeSince = new Date().toISOString(); this.modeBy = by;
      this.liveSince = this.modeSince; this.liveStartKrw = Math.round(liveEquityKrw(account, (m) => this.priceOf(m)));
      this.liveFlow = null; this.liveFlowError = null; // 새 기준점 — 입출금은 이 시각부터 다시 센다
      armReal(true);
      this.saveMode();
      this.startLiveLoop();
      try { mkdirSync(dirname(LIVE_EQUITY_FILE), { recursive: true }); appendFileSync(LIVE_EQUITY_FILE, JSON.stringify({ ts: this.modeSince, equityKrw: this.liveStartKrw, cashKrw: Math.round(account.cashKrw), positions: account.positions.size }) + "\n"); } catch { /* 스냅샷은 다음 주기 */ }
      logger.warn("⚠️ 실주문 모드 ON", { by, cashKrw: Math.round(account.cashKrw), positions: account.positions.size, equityKrw: this.liveStartKrw });
      this.pipeline.log("auto-trade", `거래 모드 → REAL (${by}) — 실계좌 ₩${this.liveStartKrw.toLocaleString()}, 보유 ${account.positions.size}종목`);
      controlPlane.useMode("real", by); // 협의회 기록은 실주문 개시 이후만
      this.emit("mode", this.mode);
      return { account };
    }
    this.mode = "paper"; this.modeSince = new Date().toISOString(); this.modeBy = by;
    armReal(false);
    this.stopLiveLoop();
    this.saveMode();
    logger.warn("실주문 모드 OFF → paper", { by });
    this.pipeline.log("auto-trade", `거래 모드 → PAPER (${by})`);
    controlPlane.useMode("paper", by);
    this.emit("mode", this.mode);
    return {};
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
    if (this.mode === "real" && !this.liveAccount) return; // 동기화 전엔 0을 찍지 않는다
    const file = this.mode === "real" ? LIVE_EQUITY_FILE : EQUITY_FILE;
    const l = this.ledger();
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(
        file,
        JSON.stringify({ ts: new Date().toISOString(), equityKrw: Math.round(this.equityKrw()), cashKrw: Math.round(l.cashKrw), positions: l.positions.size }) + "\n",
      );
    } catch (e) {
      logger.warn("에쿼티 스냅샷 실패", { error: (e as Error).message });
    }
  }

  /** 페이퍼 장부 초기화 — 포지션·주문·에쿼티 기록을 전부 지우고 시드에서 다시 시작한다. 실계좌와 무관(페이퍼 전용) */
  resetPaper(startKrw = PAPER_START_KRW): { startKrw: number; since: string; clearedOrders: number; clearedPositions: number } {
    if (this.mode === "real") throw new Error("실주문 모드에서는 페이퍼 초기화를 하지 않는다 — 먼저 paper로 전환");
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
    const file = this.mode === "real" ? LIVE_EQUITY_FILE : EQUITY_FILE;
    try {
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf-8")
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
    this.loadExits();
    this.loadMode();
    if (this.mode === "real") this.startLiveLoop();
    if (!this.paperSince) {
      this.paperSince = new Date().toISOString();
      this.saveState();
    }
    this.equityTimer = setInterval(() => this.snapshotEquity(), EQUITY_SNAPSHOT_MS);
    this.equityTimer.unref();
    setTimeout(() => this.snapshotEquity(), 30_000).unref(); // 기동 직후 1회
    this.pipeline.start(cryptoUniverse.symbols());
    // 유니버스가 바뀌면 파이프라인 추적·뉴스 심볼도 따라간다 — 알트도 신호 엔진의 거래 대상이다
    cryptoUniverse.attachHeld(() => [...this.ledger().positions.keys()].map((s) => `KRW-${s}`));
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
        this.pipeline.onTick({ symbol: COIN_OF(market), replay: true, observedAt: Date.parse(`${c.candle_date_time_utc}Z`), last: c.trade_price, bid: c.trade_price, ask: c.trade_price, bidSize: 0, askSize: 0, volume: Math.round(c.candle_acc_trade_volume) });
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
          observedAt: t.timestamp,
          last: t.trade_price,
          bid: top?.bid_price ?? t.trade_price,
          ask: top?.ask_price ?? t.trade_price,
          bidSize: top?.bid_size ?? 0,
          askSize: top?.ask_size ?? 0,
          volume: Math.round(t.acc_trade_volume_24h),
        });
      }
      void this.checkExits();
      return { rows: tickers.length };
    }
  }

  // ===== 청산 규칙 — 손절·트레일링·익절·지지 소멸 (협의회 우회, 즉시 시장가) =====

  private loadExits() {
    try {
      if (!existsSync(EXITS_FILE)) return;
      const s = JSON.parse(readFileSync(EXITS_FILE, "utf-8")) as { rules?: Partial<ExitRules>; tracks?: Array<[string, ExitTrack]>; cooldown?: Array<[string, string]>; log?: ExitEvent[] };
      if (s.rules && !validateExitRules(s.rules)) this.exitRules = { ...DEFAULT_EXIT_RULES, ...s.rules };
      this.exitTracks = new Map(s.tracks ?? []);
      this.exitCooldown = new Map(s.cooldown ?? []);
      this.exitLog = s.log ?? [];
      logger.info("청산 규칙 복원", { rules: this.exitRules, tracks: this.exitTracks.size, cooling: this.exitCooldown.size });
    } catch (e) {
      logger.warn("청산 규칙 복원 실패 — 기본값", { error: (e as Error).message });
    }
  }

  private saveExits() {
    try {
      mkdirSync(dirname(EXITS_FILE), { recursive: true });
      writeFileSync(EXITS_FILE, JSON.stringify({ rules: this.exitRules, tracks: [...this.exitTracks.entries()], cooldown: [...this.exitCooldown.entries()], log: this.exitLog.slice(0, EXIT_LOG_MAX) }));
    } catch (e) {
      logger.warn("청산 규칙 저장 실패", { error: (e as Error).message });
    }
  }

  setExitRules(patch: Partial<ExitRules>, by: string): { error?: string; rules: ExitRules } {
    const err = validateExitRules(patch);
    if (err) return { error: err, rules: this.exitRules };
    this.exitRules = { ...this.exitRules, ...patch };
    this.saveExits();
    logger.warn("[exits] 청산 규칙 변경", { by, rules: this.exitRules });
    this.pipeline.log("auto-trade", `청산 규칙 변경 (${by}) — 손절 −${this.exitRules.stopLossPct}% · 트레일링 −${this.exitRules.trailingStopPct}% · 익절 +${this.exitRules.takeProfitPct}%/${this.exitRules.takeProfitSellPct}% · 지지 소멸 ${this.exitRules.staleHours}h · 재진입 금지 ${this.exitRules.reentryCooldownMin}분${this.exitRules.enabled ? "" : " · OFF"}`);
    return { rules: this.exitRules };
  }

  /** 청산 상태 — 규칙, 보유 종목별 손절선·고점·트레일링선, 재진입 금지, 최근 실행 */
  exitStatus() {
    const now = Date.now();
    const r = this.exitRules;
    const l = this.ledger();
    const positions = [...l.positions.entries()].map(([symbol, p]) => {
      const cur = this.priceOf(`KRW-${symbol}`);
      const t = this.exitTracks.get(symbol);
      const high = Math.max(t?.highKrw ?? 0, cur);
      return {
        symbol, qty: p.qty, avgKrw: p.avgKrw, curKrw: cur,
        pnlPct: p.avgKrw > 0 && cur > 0 ? +(((cur - p.avgKrw) / p.avgKrw) * 100).toFixed(2) : 0,
        highKrw: high,
        stopKrw: +(p.avgKrw * (1 - r.stopLossPct / 100)).toPrecision(6),
        trailKrw: +(high * (1 - r.trailingStopPct / 100)).toPrecision(6),
        takeKrw: t?.tpTaken ? null : +(p.avgKrw * (1 + r.takeProfitPct / 100)).toPrecision(6),
        tpTaken: t?.tpTaken ?? false,
        unsupportedSince: t?.unsupportedSince ?? null,
        since: t?.since ?? null,
      };
    });
    const cooldown = [...this.exitCooldown.entries()].filter(([, until]) => Date.parse(until) > now).map(([symbol, until]) => ({ symbol, until }));
    return { rules: r, mode: this.mode, tradeEnabled: this.tradeEnabled, killSwitch: riskManager.killSwitchActive, positions, cooldown, log: this.exitLog.slice(0, EXIT_LOG_MAX), lastCheckAt: this.lastExitCheck ? new Date(this.lastExitCheck).toISOString() : null };
  }

  /**
   * 보유 종목을 규칙에 대 본다 — 시세 폴링마다(10초 스로틀). 걸리면 협의회·60분 간격·엣지 게이트를
   * 우회해 바로 판다. 실모드는 킬스위치·자동매매 OFF면 팔지 않고 기록만 남긴다.
   */
  async checkExits(): Promise<ExitAction[]> {
    if (this.exitBusy || Date.now() - this.lastExitCheck < EXIT_CHECK_MS) return [];
    if (this.mode === "real" && !this.liveAccount) return [];
    this.exitBusy = true;
    this.lastExitCheck = Date.now();
    try {
      const l = this.ledger();
      const positions = [...l.positions.entries()].map(([symbol, p]) => ({ symbol, qty: p.qty, lockedQty: (p as { lockedQty?: number }).lockedQty ?? 0, avgKrw: p.avgKrw, curKrw: this.priceOf(`KRW-${symbol}`) }));
      const { actions, tracks } = evaluateExits({ positions, tracks: this.exitTracks, rules: this.exitRules, supportedMarkets: controlPlane.supportedMarkets() });
      const changed = tracks.size !== this.exitTracks.size || [...tracks].some(([k, t]) => { const o = this.exitTracks.get(k); return !o || o.highKrw !== t.highKrw || o.unsupportedSince !== t.unsupportedSince; });
      this.exitTracks = tracks;
      for (const a of actions) await this.executeExit(a);
      if (changed || actions.length) this.saveExits();
      return actions;
    } catch (e) {
      logger.warn("[exits] 검사 실패", { error: (e as Error).message });
      return [];
    } finally {
      this.exitBusy = false;
    }
  }

  private async executeExit(a: ExitAction) {
    const reason = `exit:${a.kind} — ${a.reason}`;
    const event: ExitEvent = { ts: new Date().toISOString(), mode: this.mode, market: a.market, kind: a.kind, sellPct: a.sellPct, volume: a.volume, pnlPct: a.pnlPct, reason: a.reason, orderId: null, error: null };
    let order: CryptoOrder | null = null;
    if (this.mode === "real") {
      // 실주문 관문은 회전과 같다 — 다만 청산은 기존 포지션을 줄이는 것이라 주문당 상한(maxOrderKrw)은 적용하지 않는다
      const gate = riskManager.killSwitchActive ? "킬스위치 활성 — 청산도 차단" : !this.tradeEnabled ? "크립토 자동매매 OFF — 청산 기록만" : !upbit.hasKeys() ? "Upbit 키 없음" : null;
      if (gate) event.error = gate;
      else {
        const r = await live.execute([{ market: a.market, side: "sell", amountKrw: a.volume * a.curKrw, volume: a.volume, note: reason }], { reason, feePct: PAPER_FEE_PCT });
        if (r.account) { this.liveAccount = r.account; this.liveError = null; }
        const f = r.fills[0];
        if (f) { order = { id: f.uuid, market: f.market, side: "sell", volume: f.volume, priceKrw: +f.priceKrw.toFixed(0), amountKrw: Math.round(f.amountKrw), costKrw: Math.round(f.feeKrw), mode: "real", reason, ts: f.ts }; this.orders.unshift(order); }
        else event.error = r.skipped.join("; ") || "미체결";
      }
    } else {
      const r = this.paperFill(a.market, "sell", a.volume * a.curKrw, a.curKrw, reason);
      if (typeof r === "string") event.error = r; else order = r;
    }
    if (order) {
      event.orderId = order.id;
      if (this.orders.length > 100) this.orders.length = 100;
      if (a.sellPct >= 100) {
        this.exitTracks.delete(a.symbol);
        if (this.exitRules.reentryCooldownMin > 0) this.exitCooldown.set(a.symbol, new Date(Date.now() + this.exitRules.reentryCooldownMin * 60_000).toISOString());
      } else {
        const t = this.exitTracks.get(a.symbol);
        if (t) t.tpTaken = true;
      }
      this.saveState();
      this.snapshotEquity();
      this.emit("order", order);
    }
    this.exitLog.unshift(event);
    if (this.exitLog.length > EXIT_LOG_MAX) this.exitLog.length = EXIT_LOG_MAX;
    this.emit("exit", event);
    const tag = this.mode === "real" ? "REAL" : "paper";
    if (order) { logger.warn(`[exits] 청산 체결 [${tag}]`, { market: a.market, kind: a.kind, sellPct: a.sellPct, volume: a.volume, pnlPct: a.pnlPct, orderId: order.id }); this.pipeline.log("auto-trade", `${this.mode === "real" ? "⚠️ " : ""}청산 ${a.market.replace("KRW-", "")} ${a.sellPct}% [${tag}] — ${a.reason}`); }
    else { logger.warn(`[exits] 청산 실패 [${tag}]`, { market: a.market, kind: a.kind, error: event.error }); this.pipeline.log("auto-trade", `청산 실패 ${a.market.replace("KRW-", "")} [${tag}] — ${a.reason} → ${event.error}`); }
  }

  /** 페이퍼 체결 한 건 — 수수료·슬리피지를 물고 장부를 갱신한다. 실패면 사유 문자열 */
  private paperFill(market: string, side: "buy" | "sell", amountKrw: number, mid: number, reason: string): CryptoOrder | string {
    if (mid <= 0) return `${market}: 현재가 없음`;
    const slip = PAPER_SLIP_PCT / 100;
    const fee = PAPER_FEE_PCT / 100;
    const execPrice = side === "buy" ? mid * (1 + slip) : mid * (1 - slip);
    const volume = +(amountKrw / execPrice).toFixed(8);
    if (volume <= 0) return `${market}: 수량 0`;
    const grossKrw = volume * execPrice;
    const feeKrw = grossKrw * fee;
    const sym = COIN_OF(market);
    const pos = this.paperPositions.get(sym);
    if (side === "buy") {
      if (this.paperCashKrw < grossKrw + feeKrw) return `${market}: 현금 부족`;
      this.paperCashKrw -= grossKrw + feeKrw;
      if (pos) {
        pos.avgKrw = (pos.avgKrw * pos.qty + execPrice * volume) / (pos.qty + volume);
        pos.qty += volume;
      } else this.paperPositions.set(sym, { qty: volume, avgKrw: execPrice });
    } else {
      if (!pos) return `${market}: 보유 없음`;
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
    this.orders.unshift(order);
    return order;
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
   * 제어 평면 집행 — 장부를 타깃 비중으로 맞춘다. 돈 경계는 여기 한 곳:
   *   paper → 페이퍼 장부 체결 (수수료·슬리피지 부과)
   *   real  → live.ts로 Upbit 실주문 (킬스위치·주문 수 상한·현금 클램프 통과 후)
   * priceOf: 데스크가 추적하지 않는 알트 마켓의 현재가 (제어 평면이 공급).
   */
  async rotateTo(
    targets: Array<{ market: string; weightPct: number }>,
    priceOf: Map<string, number>,
    reason: string,
  ): Promise<{ orders: CryptoOrder[]; skipped: string[]; error?: string }> {
    for (const [m, px] of priceOf) if (px > 0) this.altPrices.set(m, px);
    const price = (market: string) => priceOf.get(market) ?? this.priceOf(market);
    // 청산 직후 재진입 금지 — 협의회가 방금 판 종목을 바로 되사지 않게. 보유 중이면 현재 비중으로 고정
    const cool = applyCooldown(targets, this.exitCooldown, (m) => { const eq = this.equityKrw(); const p = this.ledger().positions.get(COIN_OF(m)); const px = price(m); return eq > 0 && p && px > 0 ? (p.qty * px / eq) * 100 : 0; });
    targets = cool.targets;
    if (cool.notes.length) this.pipeline.log("auto-trade", `재진입 금지 적용 — ${cool.notes.join(" · ")}`);
    if (this.mode === "real") { const r = await this.rotateLive(targets, reason); return { ...r, skipped: [...cool.notes, ...r.skipped] }; }
    // 현재 에쿼티 (스캐너 가격 우선 — 데스크 미추적 알트 포함)
    let equity = this.paperCashKrw;
    for (const [sym, p] of this.paperPositions) {
      const px = price(`KRW-${sym}`);
      if (px > 0) equity += p.qty * px;
    }
    const done: CryptoOrder[] = [];
    const skipped: string[] = [...cool.notes];
    const fill = (market: string, side: "buy" | "sell", amountKrw: number) => {
      const r = this.paperFill(market, side, amountKrw, price(market), reason);
      if (typeof r === "string") { if (!r.endsWith("수량 0") && !r.endsWith("보유 없음")) skipped.push(r); return; }
      done.push(r);
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

  /** 실주문 계획만 (드라이런) — 계좌를 새로 읽고 주문 목록을 돌려준다. 주문은 나가지 않는다 */
  async planLive(targets: Array<{ market: string; weightPct: number }>, priceOf?: Map<string, number>) {
    const account = await this.syncLive();
    await this.refreshHeldPrices();
    const prices = new Map<string, number>();
    for (const m of new Set([...targets.map((t) => t.market), ...[...account.positions.keys()].map((s) => `KRW-${s}`)])) prices.set(m, priceOf?.get(m) || this.priceOf(m));
    const plan = planRotation({ account, prices, targets, maxOrderKrw: this.limits.maxOrderKrw, feePct: PAPER_FEE_PCT });
    return { ...plan, gate: live.gate(plan.orders.length), account: { cashKrw: Math.round(account.cashKrw), lockedKrw: Math.round(account.lockedKrw), positions: account.positions.size, syncedAt: account.syncedAt } };
  }

  private async rotateLive(targets: Array<{ market: string; weightPct: number }>, reason: string): Promise<{ orders: CryptoOrder[]; skipped: string[]; error?: string }> {
    if (!this.tradeEnabled) return { orders: [], skipped: [], error: "크립토 자동매매 OFF — 실주문 모드지만 집행하지 않는다" };
    let plan: Awaited<ReturnType<typeof this.planLive>>;
    try { plan = await this.planLive(targets); } catch (e) { return { orders: [], skipped: [], error: `실계좌 조회 실패 — 집행 취소: ${(e as Error).message}` }; }
    if (plan.gate) return { orders: [], skipped: plan.skipped, error: plan.gate };
    if (plan.orders.length === 0) { this.pipeline.log("auto-trade", `실주문 — 보낼 주문 없음 (스킵 ${plan.skipped.length}) — ${reason}`); return { orders: [], skipped: plan.skipped }; }
    const r = await live.execute(plan.orders, { reason, feePct: PAPER_FEE_PCT });
    if (r.account) { this.liveAccount = r.account; this.liveError = null; }
    const orders: CryptoOrder[] = r.fills.map((f) => ({ id: f.uuid, market: f.market, side: f.side, volume: f.volume, priceKrw: +f.priceKrw.toFixed(0), amountKrw: Math.round(f.amountKrw), costKrw: Math.round(f.feeKrw), mode: "real", reason, ts: f.ts }));
    for (const o of orders.reverse()) this.orders.unshift(o);
    if (this.orders.length > 100) this.orders.length = 100;
    this.saveState();
    this.snapshotEquity();
    const skipped = [...plan.skipped, ...r.skipped];
    this.pipeline.log("auto-trade", `⚠️ 실주문 집행 — 체결 ${orders.length}건, 스킵 ${skipped.length}건 [REAL] — ${reason}`);
    logger.warn("[live] 회전 완료", { fills: orders.length, skipped, reason });
    return { orders, skipped };
  }

  setTrade(enabled: boolean): string | null {
    this.tradeEnabled = enabled;
    this.pipeline.log("auto-trade", enabled ? `크립토 자동매매 ON (${this.mode === "real" ? "실주문" : "페이퍼"})` : "크립토 자동매매 OFF");
    return null;
  }

  modeStatus() {
    return {
      mode: this.mode,
      since: this.modeSince,
      by: this.modeBy,
      hasKeys: upbit.hasKeys(),
      killSwitch: riskManager.killSwitchActive,
      tradeEnabled: this.tradeEnabled,
      live: this.liveAccount
        ? { syncedAt: this.liveAccount.syncedAt, cashKrw: Math.round(this.liveAccount.cashKrw), lockedKrw: Math.round(this.liveAccount.lockedKrw), positions: this.liveAccount.positions.size, equityKrw: Math.round(this.mode === "real" ? this.equityKrw() : liveEquityKrw(this.liveAccount, (m) => this.priceOf(m))), startKrw: this.liveStartKrw, since: this.liveSince, flowKrw: Math.round(this.liveFlow?.netKrw ?? 0), flowError: this.liveFlowError, error: this.liveError }
        : { syncedAt: null, error: this.liveError },
      limits: { maxOrderKrw: this.limits.maxOrderKrw },
    };
  }

  status() {
    const real = this.mode === "real";
    const l = this.ledger();
    return {
      tradeEnabled: this.tradeEnabled,
      mode: this.mode,
      modeSince: this.modeSince,
      hasKeys: upbit.hasKeys(),
      // real 모드에서는 "since/start"가 실모드 시작 시점·에쿼티 — 드로다운·수익률 기준이 실계좌로 바뀐다
      paperSince: real ? this.liveSince : this.paperSince,
      paperStartKrw: real ? (this.liveStartKrw ?? 0) : PAPER_START_KRW,
      // 실모드 시작 이후 KRW 순입금(입금 − 출금·수수료). 손익 기준 = paperStartKrw + flowKrw
      flowKrw: real ? Math.round(this.liveFlow?.netKrw ?? 0) : 0,
      baseKrw: Math.round(this.baseKrw()),
      costs: { feePct: PAPER_FEE_PCT, slipPct: PAPER_SLIP_PCT },
      markets: cryptoUniverse.markets(),
      equityKrw: Math.round(this.equityKrw()),
      cashKrw: Math.round(l.cashKrw),
      live: real ? { syncedAt: this.liveAccount?.syncedAt ?? null, lockedKrw: Math.round(this.liveAccount?.lockedKrw ?? 0), depositKrw: Math.round(this.liveFlow?.depositKrw ?? 0), withdrawKrw: Math.round(this.liveFlow?.withdrawKrw ?? 0), flowSyncedAt: this.liveFlow?.syncedAt ?? null, error: this.liveError ?? this.liveFlowError } : null,
      positions: [...l.positions.entries()].map(([symbol, p]) => {
        const cur = this.priceOf(`KRW-${symbol}`);
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
