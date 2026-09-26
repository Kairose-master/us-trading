import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { PumpPortalFeed, type FeedEvent } from "./feed.js";
import { PumpLedger, DEFAULT_LEDGER_COSTS, type LedgerCosts, type LedgerSnapshot } from "./ledger.js";
import { applyOutcome, lotExits, onLeaderTrade, DEFAULT_COPY_POLICY, type CopyAction, type CopyPolicy, type Follow, type LeaderRecent } from "./copy.js";
import { initialStanding, roundTripsOf, scoreWallets, DEFAULT_THRESHOLDS, PROVISIONAL_STANDING, type ScoreThresholds, type WalletStats, type WalletTrade } from "./wallets.js";
import { parseTxDeltas, readCurve, solUsdPrice, tokenBalance, usdcBalance, waitForTx, walletSol, walletTokenBalances } from "./solana-rpc.js";
import { progress } from "./curve.js";
import { isSolanaAddress, executeTrade, liveBuySize, DEFAULT_LIVE_POLICY, type LivePolicy } from "./live.js";
import { hasSigner, signerPubkey, swapUsdcToSol } from "./signer.js";
import { communityDesk, DEFAULT_COMMUNITY_POLICY, type CommunityPolicy, type CommunityRead } from "./community.js";
import { CURATED_SEEDS, isBlockedWallet } from "./curated.js";
import { flowRead, momentumRead, type FlowTrade } from "./flow.js";
import { attribute, communityVote, copyVote, ensemble, flowVote, momentumVote, DEFAULT_ENGINE_WEIGHTS, DEFAULT_ENSEMBLE_POLICY, type EngineWeights, type EnsemblePolicy, type EnsembleRead, type Vote } from "./ensemble.js";
import { CandidateScreen } from "./screen.js";
import { launchDesk } from "./launch.js";
import type { CurveState } from "./curve.js";

/** 매수 견적 — 이벤트(스트림)에서 오든 후보 스냅샷(무료)에서 오든 같은 모양으로 장부에 넘긴다 */
interface BuyQuote { mint: string; pool: string; bondingCurveKey: string | null; curve: CurveState | null; price: number; ts: string }

/**
 * pump.fun 데스크 — 카피 트레이딩 엔진의 **페이퍼** 버전. 실주문 경로는 없다 (지갑도, 서명 키도 없다).
 *
 *   피드(PumpPortal) ─┬─ create / migrate  → 관측 기록 (data/pumpfun/events-YYYY-MM-DD.jsonl)
 *                     ├─ migrate           → 그 토큰의 거래를 discoveryWindowMin 동안 관측 (지갑 발견 — 졸업 토큰을 잘 사고파는 지갑)
 *                     ├─ 추종 지갑 거래     → copy.ts 규칙 → SOL 페이퍼 장부(ledger.ts, 본딩커브 체결)
 *                     └─ 보유 토큰 거래     → 마킹(커브 상태/가격) → 청산 규칙
 *   rescoreMin 마다 관측 거래로 지갑을 채점(wallets.ts)해 상위 followMax 를 추종한다. 수동 시드는 항상 추종.
 *   실현 결과는 지갑별 standing 으로 귀속되어 크기를 움직이고, 굶주린 지갑은 추종에서 빠진다.
 *   PumpPortal API 키(0.02 SOL 충전)가 없으면 거래 스트림이 없어 관측(create/migrate)만 돈다 — status.feed.metered 가 그걸 말한다.
 */

const DIR = join(process.cwd(), "data", "pumpfun");
const STATE_FILE = join(DIR, "state.json");
const EQUITY_FILE = join(DIR, "equity.jsonl");
const TRADES_FILE = join(DIR, "trades.jsonl");
// 실모드 — 모드 스위치와 실장부는 페이퍼와 별도 파일 (페이퍼 기록을 오염시키지 않는다)
const MODE_FILE = join(DIR, "mode.json");
const LIVE_FILE = join(DIR, "live.json");
const LIVE_EQUITY_FILE = join(DIR, "live-equity.jsonl");
const LIVE_SYNC_MS = 60_000;
const TX_TIMEOUT_MS = 90_000;
const RECONCILE_MS = 2 * 60_000;
export type PumpMode = "paper" | "real";
interface ModeState { mode: PumpMode; since: string | null; by: string | null; walletPubkey: string | null }
interface LiveState { ledger: LedgerSnapshot; policy: LivePolicy; day: { date: string; startEquitySol: number }; walletSol: number; usdc: number; solUsd: number; syncedAt: string | null; stats: { buys: number; sells: number; failed: number } }
const EQUITY_SNAPSHOT_MS = 5 * 60_000;
const MARK_STALE_MS = 10_000;
const TRADE_BUFFER_H = 48;

interface State {
  ledger: LedgerSnapshot;
  follows: Record<string, Follow>;
  seeds: string[];
  paused: boolean; pausedAt: string | null; pausedReason: string | null;
  policy: CopyPolicy;
  thresholds: ScoreThresholds;
  costs: LedgerCosts;
  discovery: Record<string, { until: string; symbol: string }>;
  day: { date: string; startEquitySol: number };
  lastRescoreAt: string | null;
  stats: { creates: number; migrations: number; tradesObserved: number; copies: number; exits: number };
  /** 유료 메시지 카운터 — 재시작해도 오늘 예산이 이어지도록 */
  metered?: { today: string; todayMsgs: number; totalMsgs: number };
  /** 커뮤니티 게이트 정책 (community.ts) */
  community?: CommunityPolicy;
  /** 복합 결정 — 엔진 가중치(실현 결과로 움직인다)·정책 */
  engineWeights?: EngineWeights;
  ensemble?: EnsemblePolicy;
  /** 로트별 진입 표 — 청산 때 엔진 귀속에 쓴다 */
  entryVotes?: Record<string, Vote[]>;
}

const today = () => new Date().toISOString().slice(0, 10);

class PumpfunDesk extends EventEmitter {
  enabled = config.PUMPFUN_ENABLED;
  feed = new PumpPortalFeed(config.PUMPFUN_WS_URL, config.PUMPFUN_API_KEY);
  ledger: PumpLedger;
  private st: State;
  /** 최근 48h 관측 거래 (지갑 채점용) */
  private trades: WalletTrade[] = [];
  private lastScore: { ranked: WalletStats[]; eligible: WalletStats[]; provisional: WalletStats[]; at: string } | null = null;
  private timers: NodeJS.Timeout[] = [];
  lastError: string | null = null;
  /** 이벤트 링 — 화면용 */
  private recent: FeedEvent[] = [];
  private recentCreates: Array<Extract<FeedEvent, { kind: "create" }>> = [];
  private recentMigrations: Array<Extract<FeedEvent, { kind: "migrate" }>> = [];
  /** 실모드 — 화면 스위치로만 켜진다. 실장부는 체인 체결로만 움직인다 */
  private modeSt: ModeState = { mode: "paper", since: null, by: null, walletPubkey: null };
  private liveSt: LiveState;
  liveLedger: PumpLedger;
  liveError: string | null = null;
  /** 진행 중인 실주문 — 같은 토큰에 두 번 사거나 같은 로트를 두 번 팔지 않게 */
  private inflight = new Set<string>();
  /** 매도 실패 백오프 — 로트별 실패 횟수와 다음 시도 가능 시각 (매 틱 재시도 폭주 방지) */
  private sellBackoff = new Map<string, { fails: number; nextAt: number }>();
  /** 복합 엔진 재료 — 토큰별 최근 10분 거래 링, 추종 지갑 활동, 마지막 견적, 후보 스크린 */
  private flowTrades = new Map<string, FlowTrade[]>();
  private followActivity = new Map<string, Array<{ wallet: string; side: "buy" | "sell"; standing: number; ts: number }>>();
  private lastQuote = new Map<string, BuyQuote>();
  screen = new CandidateScreen();
  private lastEnsemble = new Map<string, EnsembleRead>();
  private ensembleStats = { evaluations: 0, entries: 0, exits: 0 };

  constructor() {
    super();
    const restored = this.readState();
    const seeds = [...new Set([...(restored?.seeds ?? []), ...config.PUMPFUN_SEED_WALLETS, ...CURATED_SEEDS.map((c) => c.wallet)])].filter((w) => !isBlockedWallet(w));
    this.st = restored ?? { ledger: new PumpLedger(config.PUMPFUN_PAPER_START_SOL).snapshot(), follows: {}, seeds, paused: false, pausedAt: null, pausedReason: null, policy: DEFAULT_COPY_POLICY, thresholds: DEFAULT_THRESHOLDS, costs: DEFAULT_LEDGER_COSTS, discovery: {}, day: { date: today(), startEquitySol: config.PUMPFUN_PAPER_START_SOL }, lastRescoreAt: null, stats: { creates: 0, migrations: 0, tradesObserved: 0, copies: 0, exits: 0 } };
    this.st.seeds = seeds;
    this.st.policy = { ...DEFAULT_COPY_POLICY, ...this.st.policy };
    // 저장된 정책의 옛 기본값 이전 — 예산 2만 건은 흐름 엔진을 굶긴다 (실측: 후보 구독 0, flow 전부 기권)
    if (this.st.policy.meteredBudgetMsgsPerDay === 20_000) this.st.policy.meteredBudgetMsgsPerDay = DEFAULT_COPY_POLICY.meteredBudgetMsgsPerDay;
    this.st.thresholds = { ...DEFAULT_THRESHOLDS, ...this.st.thresholds };
    this.st.costs = { ...DEFAULT_LEDGER_COSTS, ...this.st.costs };
    this.ledger = PumpLedger.restore(this.st.ledger, this.st.costs);
    for (const w of seeds) if (!this.st.follows[w]) this.st.follows[w] = { wallet: w, standing: 0.5, since: new Date().toISOString(), source: "manual", closes: 0, wins: 0, cumPct: 0, returns: [] };
    // 큐레이션 차단 — 이미 추종 중이어도 뺀다 (코드가 화면보다 우선)
    for (const w of Object.keys(this.st.follows)) if (isBlockedWallet(w)) { delete this.st.follows[w]; logger.warn("[pumpfun] curated block removed a followed wallet", { wallet: w.slice(0, 8) }); }
    this.loadTradeBuffer();
    if (this.st.metered) this.feed.restoreMetered(this.st.metered);
    communityDesk.policy = { ...DEFAULT_COMMUNITY_POLICY, ...(this.st.community ?? {}) }; this.st.community = communityDesk.policy;
    this.st.engineWeights = { ...DEFAULT_ENGINE_WEIGHTS, ...(this.st.engineWeights ?? {}) };
    this.st.ensemble = { ...DEFAULT_ENSEMBLE_POLICY, ...(this.st.ensemble ?? {}) };
    if (this.st.ensemble.enterScore === 65) this.st.ensemble.enterScore = DEFAULT_ENSEMBLE_POLICY.enterScore;
    if (this.st.ensemble.exitScore === 35) this.st.ensemble.exitScore = DEFAULT_ENSEMBLE_POLICY.exitScore;
    this.st.entryVotes ??= {};
    // 실모드 상태 복원
    try { if (existsSync(MODE_FILE)) this.modeSt = { ...this.modeSt, ...(JSON.parse(readFileSync(MODE_FILE, "utf-8")) as ModeState) }; } catch (e) { logger.warn("[pumpfun] mode restore failed — paper", { error: (e as Error).message }); }
    if (!this.modeSt.walletPubkey && config.PUMPFUN_WALLET_PUBKEY) this.modeSt.walletPubkey = config.PUMPFUN_WALLET_PUBKEY;
    let live: LiveState | null = null;
    try { if (existsSync(LIVE_FILE)) live = JSON.parse(readFileSync(LIVE_FILE, "utf-8")) as LiveState; } catch (e) { logger.warn("[pumpfun] live ledger restore failed — fresh", { error: (e as Error).message }); }
    this.liveSt = live ?? { ledger: new PumpLedger(0).snapshot(), policy: DEFAULT_LIVE_POLICY, day: { date: today(), startEquitySol: 0 }, walletSol: 0, usdc: 0, solUsd: 0, syncedAt: null, stats: { buys: 0, sells: 0, failed: 0 } };
    this.liveSt.usdc ??= 0; this.liveSt.solUsd ??= 0;
    this.liveSt.policy = { ...DEFAULT_LIVE_POLICY, ...this.liveSt.policy };
    // 저장된 옛 기본값(25/100/20) → 러그 시장용 기본값으로 이전
    if (this.liveSt.policy.maxPositionPct === 25 && this.liveSt.policy.grossMaxPct === 100) { this.liveSt.policy.maxPositionPct = DEFAULT_LIVE_POLICY.maxPositionPct; this.liveSt.policy.grossMaxPct = DEFAULT_LIVE_POLICY.grossMaxPct; }
    // 일 손실 정지 폐지 — 저장된 옛 기본값(15·20)은 끔(0)으로, 그 사유로 정지돼 있으면 해제 (owner 가 직접 감시)
    if (this.liveSt.policy.dailyStopPct === 15 || this.liveSt.policy.dailyStopPct === 20) this.liveSt.policy.dailyStopPct = 0;
    if (this.st.paused && (this.st.pausedReason?.includes("daily stop") ?? false)) { this.st.paused = false; this.st.pausedAt = null; this.st.pausedReason = null; logger.warn("[pumpfun] daily stop removed — clearing that paused state on boot"); }
    this.liveLedger = PumpLedger.restore(this.liveSt.ledger, this.st.costs);
    if (this.modeSt.mode === "real" && !this.feed.hasKey && !hasSigner()) { logger.warn("[pumpfun] real mode restored without PUMPFUN_API_KEY or PUMPFUN_WALLET_SECRET — falling back to paper"); this.modeSt.mode = "paper"; }
    // 이벤트 핸들러는 기동 여부와 무관하게 건다 — 피드 연결만 start()가 한다 (테스트에서 합성 이벤트를 넣을 수 있게)
    this.feed.on("event", (ev: FeedEvent) => { try { this.onEvent(ev); } catch (e) { this.lastError = (e as Error).message; logger.warn("[pumpfun] event handling failed", { error: this.lastError, kind: ev.kind }); } });
    this.feed.on("open", () => this.syncSubscriptions());
  }

  // ===== 영속화 =====
  private readState(): State | null {
    try { if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State; } catch (e) { logger.warn("[pumpfun] state restore failed — fresh", { error: (e as Error).message }); }
    return null;
  }
  private save() {
    try {
      mkdirSync(DIR, { recursive: true });
      this.st.ledger = this.ledger.snapshot();
      const m = this.feed.status().metered; this.st.metered = { today: m.today, todayMsgs: m.todayMsgs, totalMsgs: m.totalMsgs };
      const tmp = `${STATE_FILE}.tmp`; writeFileSync(tmp, JSON.stringify(this.st)); renameSync(tmp, STATE_FILE);
    } catch (e) { logger.warn("[pumpfun] state save failed", { error: (e as Error).message }); }
  }
  private saveLive() {
    try { mkdirSync(DIR, { recursive: true }); this.liveSt.ledger = this.liveLedger.snapshot(); const tmp = `${LIVE_FILE}.tmp`; writeFileSync(tmp, JSON.stringify(this.liveSt)); renameSync(tmp, LIVE_FILE); writeFileSync(MODE_FILE, JSON.stringify(this.modeSt)); }
    catch (e) { logger.warn("[pumpfun] live save failed", { error: (e as Error).message }); }
  }
  private appendJsonl(file: string, row: unknown) { try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(row) + "\n"); } catch (e) { this.lastError = (e as Error).message; } }
  private loadTradeBuffer() {
    try {
      if (!existsSync(TRADES_FILE)) return;
      const cutoff = Date.now() - TRADE_BUFFER_H * 3_600_000;
      const lines = readFileSync(TRADES_FILE, "utf-8").split("\n").filter(Boolean);
      for (const line of lines.slice(-200_000)) { try { const t = JSON.parse(line) as WalletTrade; if (Date.parse(t.ts) >= cutoff) this.trades.push(t); } catch { /* skip */ } }
      logger.info("[pumpfun] trade buffer restored", { trades: this.trades.length });
    } catch (e) { logger.warn("[pumpfun] trade buffer restore failed", { error: (e as Error).message }); }
  }

  // ===== 기동 =====
  start() {
    if (!this.enabled) { logger.info("[pumpfun] disabled (PUMPFUN_ENABLED=false)"); return; }
    this.feed.subscribeNewToken(true);
    this.feed.subscribeMigration(true);
    this.feed.start();
    this.timers.push(setInterval(() => void this.tick(), 15_000));
    this.timers.push(setInterval(() => this.snapshotEquity(), EQUITY_SNAPSHOT_MS));
    this.timers.push(setInterval(() => this.rescore(), this.st.policy.rescoreMin * 60_000));
    // 첫 채점은 기동 3분 뒤 — 30분을 빈손으로 기다리지 않게
    setTimeout(() => { if (this.trades.length) this.rescore(); }, 3 * 60_000).unref();
    this.timers.push(setInterval(() => { if (this.modeSt.mode === "real") void this.syncWallet(); }, LIVE_SYNC_MS));
    this.timers.push(setInterval(() => void this.pollHeldCommunity(), 60_000));
    this.timers.push(setInterval(() => void this.screen.poll().then(() => this.syncSubscriptions()), 30_000));
    this.timers.push(setInterval(() => void this.evaluateEnsemble(), 15_000));
    setTimeout(() => void this.screen.poll().then(() => this.syncSubscriptions()), 5_000).unref();
    this.timers.push(setInterval(() => { if (this.modeSt.mode === "real") void this.reconcileLive(); }, RECONCILE_MS));
    if (this.modeSt.mode === "real") setTimeout(() => void this.reconcileLive(), 10_000).unref();
    if (this.modeSt.mode === "real") { logger.warn("[pumpfun] REAL mode active", { wallet: this.modeSt.walletPubkey }); void this.syncWallet(); }
    for (const t of this.timers) t.unref();
    logger.info("[pumpfun] desk started (paper, SOL)", { startSol: this.ledger.startSol, follows: Object.keys(this.st.follows).length, seeds: this.st.seeds.length, key: this.feed.hasKey });
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; this.feed.stop(); this.save(); this.saveLive(); }

  /** 추종 지갑·보유 토큰·발견 창 구독을 피드에 맞춘다 (재연결 때도 호출) */
  private syncSubscriptions() {
    if (!this.feed.hasKey) return;
    // 정지 중에는 유료 구독(토큰·지갑 거래 스트림)을 전부 끊는다 — 돈이 타지 않게. 무료 스트림(신규·이주)은 유지.
    // 보유분 청산은 계속 돈다: 커브 토큰은 15초 RPC 마킹, AMM 토큰은 60초 pump.fun 시총 마킹(pollHeldCommunity)
    if (this.st.paused) {
      const accts = this.feed.subscribedAccounts(), toks = this.feed.subscribedTokens();
      if (accts.length || toks.length) logger.warn("[pumpfun] paused — dropping metered subscriptions", { accounts: accts.length, tokens: toks.length });
      this.feed.unsubscribeAccounts(accts); this.feed.unsubscribeTokens(toks); this.st.discovery = {};
      return;
    }
    // 추종 지갑 + 보유 토큰의 creator (개발자가 팔면 우리도 판다 — 지갑당 메시지가 적어 싸다)
    const wantAccounts = new Set([...Object.keys(this.st.follows), ...this.heldCreators()]);
    const haveAccounts = new Set(this.feed.subscribedAccounts());
    this.feed.subscribeAccounts([...wantAccounts].filter((w) => !haveAccounts.has(w)));
    this.feed.unsubscribeAccounts([...haveAccounts].filter((w) => !wantAccounts.has(w)));
    const now = Date.now();
    for (const [mint, d] of Object.entries(this.st.discovery)) if (Date.parse(d.until) < now) delete this.st.discovery[mint];
    // 예산 초과 — 발견 창을 전부 닫는다. 추종 지갑(싸다)과 보유 토큰(필요하다)만 남긴다
    if (this.overBudget() && Object.keys(this.st.discovery).length) { logger.warn("[pumpfun] metered budget exceeded — closing discovery windows", { today: this.feed.meteredToday(), budget: this.st.policy.meteredBudgetMsgsPerDay }); this.st.discovery = {}; }
    // 보유 토큰: 커브 토큰은 무료 RPC 폴링(tick)으로 마킹하니 구독하지 않는다(정책 0). AMM 토큰은 무료 시세원이 없어 구독한다
    const held = [...this.ledger.lots.values(), ...this.liveLedger.lots.values()].filter((l) => this.st.policy.subscribeHeldTokens >= 1 || l.pool !== "pump").map((l) => l.mint);
    // 폭주 토큰 색출 — 후보로 구독한 토큰이 분당 floodMintPerMin 을 넘으면 신호가 아니라 노이즈다(초당 수 건). 끊고 쿨다운
    const heldSet = new Set([...held, ...Object.keys(this.st.discovery)]);
    for (const { mint, perMin } of this.feed.mintRates()) {
      if (perMin >= this.st.policy.floodMintPerMin && !heldSet.has(mint)) { this.floodBlock.set(mint, now + this.st.policy.floodCooldownMin * 60_000); logger.warn("[pumpfun] flooding token evicted from stream", { mint: mint.slice(0, 8), perMin }); }
    }
    for (const [mint, until] of this.floodBlock) if (until < now) this.floodBlock.delete(mint);
    // 탄력 구독 개수 — 하루 예산을 24시간에 고르게 쓰도록 페이스를 잡고, 최근 분당 소진 속도가 페이스를 넘으면 후보 수를 줄인다
    const pacePerMin = this.st.policy.meteredBudgetMsgsPerDay / 1440;
    const rate = this.feed.msgsPerMin();
    const ratio = pacePerMin > 0 ? rate / pacePerMin : 1;
    // ratio ≤ 1 이면 최대(flowMaxMints), 2배면 0 — 선형으로 줄이고 최소 0
    const elasticMax = Math.max(0, Math.round(this.st.policy.flowMaxMints * Math.min(1, Math.max(0, 2 - ratio))));
    this.elasticFlowMax = elasticMax;
    // 복합 엔진 후보 — 무료 스냅샷 모멘텀 상위, 폭주·쿨다운 토큰은 빼고, 탄력 개수만큼만 유료 스트림 (예산 초과면 0)
    const flowMints = this.overBudget() ? [] : this.flowCandidates().filter((c) => !this.floodBlock.has(c.mint)).slice(0, elasticMax).map((c) => c.mint);
    const wantTokens = new Set([...held, ...Object.keys(this.st.discovery), ...flowMints]);
    const haveTokens = new Set(this.feed.subscribedTokens());
    this.feed.subscribeTokens([...wantTokens].filter((m) => !haveTokens.has(m)));
    this.feed.unsubscribeTokens([...haveTokens].filter((m) => !wantTokens.has(m)));
  }
  /** 폭주로 끊긴 토큰 → 재구독 금지 만료 시각 */
  private floodBlock = new Map<string, number>();
  private elasticFlowMax = 0;

  private overBudget(): boolean { return this.feed.meteredToday() >= this.st.policy.meteredBudgetMsgsPerDay; }
  /** 보호 종목 — 봇이 절대 사고팔지 않고 편입도 안 한다: 대시보드로 발행한 mint + config 목록(스크립트 발행 SCAM·수동 보유분) */
  private protectedMints = new Set<string>(config.PUMPFUN_PROTECTED_MINTS);
  isProtectedMint(mint: string): boolean { return launchDesk.isOwnMint(mint) || this.protectedMints.has(mint); }

  // ===== 이벤트 =====
  private onEvent(ev: FeedEvent) {
    this.recent.push(ev); if (this.recent.length > 300) this.recent.shift();
    if (ev.kind === "create") {
      this.st.stats.creates += 1;
      communityDesk.noteLaunch(ev.creator, Date.parse(ev.ts) || Date.now(), ev.mint, ev.initialBuySol);
      this.recentCreates.push(ev); if (this.recentCreates.length > 100) this.recentCreates.shift();
      this.appendJsonl(join(DIR, `events-${today()}.jsonl`), { k: "c", ts: ev.ts, mint: ev.mint, sym: ev.symbol, creator: ev.creator, buySol: ev.initialBuySol, vSol: ev.vSol, mcap: ev.marketCapSol });
      return;
    }
    if (ev.kind === "migrate") {
      this.st.stats.migrations += 1;
      this.recentMigrations.push(ev); if (this.recentMigrations.length > 100) this.recentMigrations.shift();
      this.appendJsonl(join(DIR, `events-${today()}.jsonl`), { k: "m", ts: ev.ts, mint: ev.mint, pool: ev.pool });
      this.screen.noteMigration(ev.mint, Date.parse(ev.ts) || Date.now());
      // 지갑 발견 창 — 졸업 토큰의 거래를 잠시 관측한다 (유료 스트림이라 창·개수·일 예산으로 제한). 복합 엔진 후보 구독은 syncSubscriptions 가 따로 건다
      if (this.feed.hasKey && !this.st.paused && !this.overBudget() && Object.keys(this.st.discovery).length < this.st.policy.discoveryMaxMints) {
        this.st.discovery[ev.mint] = { until: new Date(Date.now() + this.st.policy.discoveryWindowMin * 60_000).toISOString(), symbol: "" };
        this.feed.subscribeTokens([ev.mint]);
      }
      this.ledger.mark(ev.mint, { pool: ev.pool || "pump-amm" });
      return;
    }
    // trade
    this.st.stats.tradesObserved += 1;
    { const ring = this.flowTrades.get(ev.mint) ?? []; ring.push({ wallet: ev.wallet, side: ev.side, sol: ev.sol, ts: Date.parse(ev.ts) || Date.now() }); const cut = Date.now() - 10 * 60_000; while (ring.length && ring[0].ts < cut) ring.shift(); if (ring.length > 3000) ring.splice(0, ring.length - 3000); this.flowTrades.set(ev.mint, ring); if (this.flowTrades.size > 400) { for (const [k, v] of this.flowTrades) { if (!v.length || v[v.length - 1].ts < cut) this.flowTrades.delete(k); } } }
    this.lastQuote.set(ev.mint, this.quoteFromEvent(ev));
    const wt: WalletTrade = { wallet: ev.wallet, mint: ev.mint, side: ev.side, sol: ev.sol, tokens: ev.tokens, ts: ev.ts };
    this.trades.push(wt); this.appendJsonl(TRADES_FILE, wt);
    if (this.trades.length > 400_000) this.trades.splice(0, this.trades.length - 300_000);
    // 보유 토큰 마킹 — 커브면 이벤트가 실어 온 준비금(정확), AMM이면 체결가 (페이퍼·실장부 둘 다)
    const markArg = ev.pool === "pump" && ev.vSol > 0 ? { curve: { vSol: ev.vSol, vTokens: ev.vTokens }, pool: "pump" } : { price: ev.tokens > 0 ? ev.sol / ev.tokens : 0, pool: ev.pool || "pump-amm" };
    if (this.ledger.lotsOf(ev.mint).length) this.ledger.mark(ev.mint, markArg, ev.ts);
    if (this.liveLedger.lotsOf(ev.mint).length) this.liveLedger.mark(ev.mint, markArg, ev.ts);
    // 개발자 매도 — 보유 토큰의 creator 가 그 토큰을 팔면 전량 청산 (밈코인의 "공시": 만든 사람이 나간다)
    if (ev.side === "sell" && this.heldCreators().has(ev.wallet) && (this.ledger.lotsOf(ev.mint).length || this.liveLedger.lotsOf(ev.mint).length) && communityDesk.cached(ev.mint)?.facts.creator === ev.wallet) {
      logger.warn("[pumpfun] creator sold a held token — exiting", { mint: ev.mint, sol: ev.sol });
      for (const l of this.ledger.lotsOf(ev.mint)) this.apply({ type: "sell", lotId: l.id, fraction: 1, reason: `dev sold ${ev.sol.toFixed(3)} SOL` }, ev);
      if (this.modeSt.mode === "real") for (const l of this.liveLedger.lotsOf(ev.mint)) void this.applyLive({ type: "sell", lotId: l.id, fraction: 1, reason: `dev sold ${ev.sol.toFixed(3)} SOL` }, ev);
    }
    // 추종 지갑이면 카피 규칙 — 매수는 커뮤니티를 읽은 뒤(비동기), 매도는 즉시
    const follow = this.st.follows[ev.wallet];
    const recent = follow && ev.side === "buy" ? this.leaderRecent(ev.wallet, ev.mint) : undefined;
    if (follow) {
      // 추종 지갑의 표 — 플립·스캘핑 중인 매수는 표가 아니다
      const flipping = recent && (recent.flipsOnMint10m >= this.st.policy.maxLeaderFlips10m || (recent.medianHoldMin30m !== null && recent.medianHoldMin30m < this.st.policy.minLeaderHoldMin));
      if (ev.side === "sell" || !flipping) { const l = this.followActivity.get(ev.mint) ?? []; l.push({ wallet: ev.wallet, side: ev.side, standing: follow.standing, ts: Date.now() }); this.followActivity.set(ev.mint, l.filter((x) => Date.now() - x.ts < 10 * 60_000)); }
      const actions = onLeaderTrade(ev, { policy: this.st.policy, follow, lots: [...this.ledger.lots.values()], equitySol: this.ledger.equitySol(), cashSol: this.ledger.cashSol, positionsSol: this.ledger.positionsSol(), paused: this.st.paused, recent });
      for (const a of actions) {
        if (a.type === "buy") { if (this.st.policy.directCopy >= 1) void this.copyBuy(a, ev, "paper"); else logger.info("[pumpfun] follow buy recorded as a vote (directCopy off)", { leader: ev.wallet.slice(0, 8), mint: ev.mint.slice(0, 8) }); }
        else { if (a.type === "skip" && ev.side === "buy") logger.info("[pumpfun] copy skipped", { leader: ev.wallet.slice(0, 8), mint: ev.mint.slice(0, 8), why: a.reason }); this.apply(a, ev); }
      }
    }
    // 마킹 뒤 청산 규칙
    for (const a of lotExits(this.ledger.lotsOf(ev.mint), this.st.policy)) this.apply(a, ev);
    // 실모드 — 같은 규칙을 실장부 위에서 한 번 더 돌리고, 결과는 체인으로 나간다
    if (this.modeSt.mode === "real") {
      if (follow) {
        const acts = onLeaderTrade(ev, { policy: this.st.policy, follow, lots: [...this.liveLedger.lots.values()], equitySol: this.liveEquitySol(), cashSol: this.liveSt.walletSol, positionsSol: this.liveLedger.positionsSol(), paused: this.st.paused, recent: recent ?? (ev.side === "buy" ? this.leaderRecent(ev.wallet, ev.mint) : undefined) });
        for (const a of acts) { if (a.type === "buy") { if (this.st.policy.directCopy >= 1) void this.copyBuy(a, ev, "live"); } else void this.applyLive(a, ev); }
      }
      for (const a of lotExits(this.liveLedger.lotsOf(ev.mint), this.st.policy)) void this.applyLive(a, ev);
    }
  }

  /** 리더의 최근 행동 — 이 토큰을 플립 중인가, 요즘 스캘핑 모드인가, 우리가 방금 판 토큰인가 (copy.ts 플립 방지 규칙의 재료) */
  private leaderRecent(wallet: string, mint: string): LeaderRecent {
    const now = Date.now();
    const mine = this.trades.filter((t) => t.wallet === wallet && now - Date.parse(t.ts) < 30 * 60_000);
    const rts = roundTripsOf(mine).get(wallet) ?? [];
    const flips = rts.filter((r) => r.mint === mint && now - Date.parse(r.closedAt) < 10 * 60_000).length;
    const holds = rts.map((r) => r.holdMin).sort((a, b) => a - b);
    const median = holds.length ? holds[holds.length >> 1] : null;
    const lastExit = [...this.ledger.orders].reverse().find((o) => o.side === "sell" && o.mint === mint);
    return { flipsOnMint10m: flips, medianHoldMin30m: median, ourLastExitMinAgo: lastExit ? (now - Date.parse(lastExit.ts)) / 60_000 : null };
  }
  /** 후보 정렬 — 무료 스냅샷 모멘텀 점수 순 (유료 스트림을 걸 순서) */
  private flowCandidates() {
    const now = Date.now();
    return this.screen.candidates().map((c) => ({ mint: c.mint, m: momentumVote(momentumRead(c.mint, c.snaps, now, c.migratedAt)) })).filter((x) => !x.m.abstain).sort((a, b) => b.m.score - a.m.score);
  }
  private rankedScoreOf(): (w: string) => number { const m = new Map((this.lastScore?.ranked ?? []).map((w) => [w.wallet, w.score])); return (w) => m.get(w) ?? 0; }

  /** 복합 결정 — 15초마다 후보·보유 토큰마다 엔진 넷의 표를 모아 진입/청산 */
  async evaluateEnsemble() {
    const now = Date.now(); const P = this.st.ensemble ?? DEFAULT_ENSEMBLE_POLICY; const W = this.st.engineWeights ?? DEFAULT_ENGINE_WEIGHTS;
    const rankedScore = this.rankedScoreOf();
    const heldMints = new Set([...this.ledger.heldMints(), ...this.liveLedger.heldMints()]);
    const mints = [...new Set([...this.flowCandidates().slice(0, 20).map((c) => c.mint), ...heldMints])];
    let reads = 0;
    const entries: Array<{ mint: string; r: EnsembleRead; votes: Vote[] }> = [];
    for (const mint of mints) {
      if (this.isProtectedMint(mint)) continue; // 보호 종목(SCAM·수동 보유)은 복합 결정에서 제외 — 이해충돌
      const cand = this.screen.get(mint);
      const flow = this.flowTrades.has(mint) ? flowRead(mint, this.flowTrades.get(mint)!, now, rankedScore) : null;
      const mom = cand ? momentumRead(mint, cand.snaps, now, cand.migratedAt) : null;
      const act = (this.followActivity.get(mint) ?? []).filter((x) => now - x.ts < 10 * 60_000);
      const cv = copyVote(act.filter((x) => x.side === "buy").map((x) => ({ wallet: x.wallet, standing: x.standing, minAgo: (now - x.ts) / 60_000 })), act.filter((x) => x.side === "sell").map((x) => ({ wallet: x.wallet, standing: x.standing, minAgo: (now - x.ts) / 60_000 })));
      const fv = flowVote(flow, P), mv = momentumVote(mom);
      const held = heldMints.has(mint);
      // 커뮤니티는 진입 후보(흐름·모멘텀이 강할 때)와 보유분만 읽는다 — 공개 API 초당 1회
      let comm = communityDesk.cached(mint);
      const promising = (!fv.abstain && fv.score >= 65) || (!mv.abstain && mv.score >= 65) || !cv.abstain;
      if (!comm && (held || promising) && reads < 3) { reads += 1; try { comm = await communityDesk.read(mint, { timeoutMs: 4_000 }); } catch { comm = null; } }
      const votes = [fv, mv, cv, communityVote(comm)];
      const heldLots = [...this.ledger.lotsOf(mint), ...this.liveLedger.lotsOf(mint)];
      const heldPnl = heldLots.length ? Math.max(...heldLots.map((l) => (l.costSol > 0 ? ((l.markSol - l.costSol) / l.costSol) * 100 : 0))) : 0;
      const r = ensemble(mint, votes, W, P, held, comm, flow, mom, heldPnl);
      this.lastEnsemble.set(mint, r); this.ensembleStats.evaluations += 1;
      if (r.action === "enter" && !this.st.paused) { entries.push({ mint, r, votes }); }
      else if (r.action === "exit") {
        this.ensembleStats.exits += 1;
        for (const l of this.ledger.lotsOf(mint)) if (l.via === "rule:ensemble" || l.via === "rule:conviction") this.apply({ type: "sell", lotId: l.id, fraction: 1, reason: r.why });
        if (this.modeSt.mode === "real") for (const l of this.liveLedger.lotsOf(mint)) if (l.via === "rule:ensemble" || l.via === "rule:conviction" || l.via === "chain:adopted") void this.applyLive({ type: "sell", lotId: l.id, fraction: 1, reason: r.why });
      }
    }
    // 진입 집행 — 기본은 자격 후보를 각각 basePct 로. 확신 집중 모드면 점수 최상위 하나(들)에만 크게 몰고 나머지는 버린다
    entries.sort((a, b) => b.r.score - a.r.score);
    const conv = this.st.policy;
    if (conv.convictionMode >= 1) {
      const openConv = [...this.liveLedger.lots.values(), ...this.ledger.lots.values()].filter((l) => l.via === "rule:conviction").length;
      const slots = Math.max(0, conv.maxConvictionLots - openConv);
      const picks = entries.filter((e) => e.r.score >= conv.convictionMinScore && !e.r.blocked).slice(0, slots);
      for (const e of picks) {
        const solIn = +(this.ledger.equitySol() * (conv.convictionPct / 100) * e.r.sizeMult).toFixed(6);
        const a = { type: "buy" as const, mint: e.mint, solIn, via: "rule:conviction", reason: `CONVICTION ${e.r.score}: ${e.votes.filter((v) => !v.abstain).map((v) => `${v.engine} ${v.score}`).join(" · ")}` };
        const lotId = this.apply(a);
        if (lotId) { this.st.entryVotes![lotId] = e.votes; this.ensembleStats.entries += 1; this.syncSubscriptions(); }
        if (this.modeSt.mode === "real") void this.applyLive(a, undefined, e.r.sizeMult, 1, conv.convictionPct);
      }
    } else {
      for (const e of entries) {
        const solIn = +(this.ledger.equitySol() * (P.basePct / 100) * e.r.sizeMult).toFixed(6);
        const a = { type: "buy" as const, mint: e.mint, solIn, via: "rule:ensemble", reason: `ensemble ${e.r.score}: ${e.votes.filter((v) => !v.abstain).map((v) => `${v.engine} ${v.score}`).join(" · ")}` };
        const lotId = this.apply(a);
        if (lotId) { this.st.entryVotes![lotId] = e.votes; this.ensembleStats.entries += 1; this.syncSubscriptions(); }
        if (this.modeSt.mode === "real") void this.applyLive(a, undefined, e.r.sizeMult, 1);
      }
    }
    for (const [m] of this.lastEnsemble) if (!mints.includes(m)) this.lastEnsemble.delete(m);
  }
  ensembleStatus() {
    const list = [...this.lastEnsemble.values()].sort((a, b) => b.score - a.score).slice(0, 20).map((r) => ({ mint: r.mint, symbol: this.screen.get(r.mint)?.symbol ?? null, score: r.score, action: r.action, why: r.why, blocked: r.blocked, sizeMult: r.sizeMult, votes: r.votes.map((v) => ({ engine: v.engine, score: v.score, abstain: v.abstain, why: v.why.slice(0, 3) })), streamed: this.feed.subscribedTokens().includes(r.mint), held: this.ledger.lotsOf(r.mint).length + this.liveLedger.lotsOf(r.mint).length }));
    return { weights: this.st.engineWeights ?? DEFAULT_ENGINE_WEIGHTS, policy: this.st.ensemble ?? DEFAULT_ENSEMBLE_POLICY, directCopy: this.st.policy.directCopy, flowMaxMints: this.st.policy.flowMaxMints, conviction: { mode: this.st.policy.convictionMode, pct: this.st.policy.convictionPct, minScore: this.st.policy.convictionMinScore, maxLots: this.st.policy.maxConvictionLots, open: [...this.liveLedger.lots.values(), ...this.ledger.lots.values()].filter((l) => l.via === "rule:conviction").length }, elastic: { msgsPerMin: this.feed.msgsPerMin(), pacePerMin: Math.round(this.st.policy.meteredBudgetMsgsPerDay / 1440), activeFlowMax: this.elasticFlowMax, floodBlocked: this.floodBlock.size, topMintRates: this.feed.mintRates().slice(0, 5) }, screen: { candidates: this.screen.candidates().length, lastPollAt: this.screen.lastPollAt, ...this.screen.stats }, stats: this.ensembleStats, candidates: list };
  }
  /** 보유 토큰(페이퍼·실)의 creator 지갑들 — 커뮤니티 읽기에 creator 가 있을 때만 */
  private heldCreators(): Set<string> {
    const out = new Set<string>();
    for (const m of new Set([...this.ledger.heldMints(), ...this.liveLedger.heldMints()])) { const c = communityDesk.cached(m)?.facts.creator; if (c) out.add(c); }
    return out;
  }
  /** 카피 매수 — 커뮤니티를 읽어(캐시 60s) 크기를 곱하거나 거른다. 데이터가 없으면 ×0.75 (모른다 ≠ 양성) */
  private async copyBuy(a: Extract<CopyAction, { type: "buy" }>, ev: Extract<FeedEvent, { kind: "trade" }>, target: "paper" | "live") {
    if (this.isProtectedMint(ev.mint)) return; // 보호 종목은 우리가 사지 않는다
    let read: CommunityRead;
    try { read = await communityDesk.read(ev.mint); } catch (e) { logger.warn("[pumpfun] community read threw", { error: (e as Error).message }); return; }
    if (read.block) { if (target === "paper") logger.info("[pumpfun] copy buy skipped by community gate", { mint: ev.mint.slice(0, 8), score: read.score, why: read.reasons.slice(-2) }); return; }
    const reason = `${a.reason} · community ${read.score}${read.unknown ? "?" : ""} ×${read.multiplier}`;
    if (target === "paper") { this.apply({ ...a, solIn: +(a.solIn * read.multiplier).toFixed(6), reason }, ev); this.syncSubscriptions(); }
    else await this.applyLive({ ...a, reason }, ev, read.multiplier);
  }
  /** 보유 토큰의 커뮤니티를 60초마다 다시 읽는다 — 댓글 증가율 갱신, 보안 판정이 바뀌면 청산 */
  private async pollHeldCommunity() {
    const mints = [...new Set([...this.ledger.heldMints(), ...this.liveLedger.heldMints()])].slice(0, 12);
    for (const m of mints) {
      try {
        // AMM(졸업) 토큰은 거래가 뜸하면 마킹이 안 온다 — pump.fun 시총(SOL)으로 60초마다 폴백 마킹 (원가 모름 로트는 이게 첫 원가가 된다)
        // 정지 중엔 스트림이 없으니 매 폴링(60초)마다 마킹한다
        const staleMs = this.st.paused ? 50_000 : 3 * 60_000;
        const stale = [...this.ledger.lotsOf(m), ...this.liveLedger.lotsOf(m)].some((l) => l.pool !== "pump" && (!(l.markSol > 0) || Date.now() - Date.parse(l.markAt) > staleMs));
        if (stale) { const b = await communityDesk.coinBasics(m).catch(() => null); if (b && b.marketCapSol > 0) { const arg = { price: b.marketCapSol / 1_000_000_000, pool: b.complete ? "pump-amm" : "pump" }; this.ledger.mark(m, arg); this.liveLedger.mark(m, arg); } }
        const r = await communityDesk.read(m, { force: true, timeoutMs: 4_000 });
        if (r.facts.ok && r.facts.securityVerdict && r.facts.securityVerdict !== "allow") {
          logger.warn("[pumpfun] security verdict changed on a held token — exiting", { mint: m, verdict: r.facts.securityVerdict });
          for (const l of this.ledger.lotsOf(m)) this.apply({ type: "sell", lotId: l.id, fraction: 1, reason: `security verdict ${r.facts.securityVerdict}` });
          if (this.modeSt.mode === "real") for (const l of this.liveLedger.lotsOf(m)) void this.applyLive({ type: "sell", lotId: l.id, fraction: 1, reason: `security verdict ${r.facts.securityVerdict}` });
        }
      } catch (e) { this.lastError = (e as Error).message; }
    }
    this.syncSubscriptions();
  }

  // ===== 실주문 =====
  /** USDC 를 SOL 로 환산 — 자본 기준(에쿼티)에 포함. 실제 매수는 네이티브 SOL 로만 나가고 liveBuySize 가 지갑 SOL 로 상한을 건다 */
  usdcInSol(): number { return this.liveSt.solUsd > 0 ? this.liveSt.usdc / this.liveSt.solUsd : 0; }
  liveEquitySol(): number { return this.liveSt.walletSol + this.usdcInSol() + this.liveLedger.positionsSol(); }
  async syncWallet(): Promise<number> {
    if (!this.modeSt.walletPubkey) return this.liveSt.walletSol;
    try {
      const [sol, usdc, px] = await Promise.all([walletSol(this.modeSt.walletPubkey), usdcBalance(this.modeSt.walletPubkey).catch(() => this.liveSt.usdc), solUsdPrice().catch(() => 0)]);
      this.liveSt.walletSol = sol; this.liveSt.usdc = usdc; if (px > 0) this.liveSt.solUsd = px;
      this.liveSt.syncedAt = new Date().toISOString(); this.liveError = null;
    } catch (e) { this.liveError = (e as Error).message; }
    return this.liveSt.walletSol;
  }
  /** 목표 SOL 에 지갑이 못 미치면 부족분을 USDC→SOL 스왑으로 채운다 — 로컬 서명일 때만(Lightning 은 키가 PumpPortal 에 있어 스왑 불가) */
  private async ensureWalletSol(targetSol: number): Promise<void> {
    if (!hasSigner()) return;
    const need = targetSol - this.liveSt.walletSol;
    if (need <= 0.0005 || this.liveSt.usdc <= 0 || this.liveSt.solUsd <= 0) return;
    const usdcNeeded = Math.min(this.liveSt.usdc, need * this.liveSt.solUsd * 1.03); // 3% 버퍼(슬리피지·수수료)
    if (usdcNeeded < 0.5) return; // 0.5 USDC 미만은 스왑 비용이 더 든다
    try {
      const { signature, outSol } = await swapUsdcToSol(usdcNeeded, 100); // USDC/SOL 은 유동성 깊음 — 1% 슬리피지 상한
      logger.warn("[pumpfun] USDC→SOL swap", { usdc: +usdcNeeded.toFixed(3), outSol: +outSol.toFixed(4), signature });
      await waitForTx(signature, TX_TIMEOUT_MS).catch(() => null);
      await this.syncWallet();
    } catch (e) { this.liveError = `usdc swap: ${(e as Error).message}`; logger.warn("[pumpfun] USDC→SOL swap failed", { error: this.liveError }); }
  }
  private async applyLive(a: CopyAction, ev?: Extract<FeedEvent, { kind: "trade" }>, mult = 1, standingOverride?: number, pctOverride?: number) {
    if (a.type === "skip") return;
    const P = this.liveSt.policy;
    if (a.type === "buy") {
      const q = ev ? this.quoteFromEvent(ev) : this.lastQuote.get(a.mint) ?? this.quoteFromCandidate(a.mint);
      if (!q) { logger.warn("[pumpfun] live buy: no quote", { mint: a.mint }); return; }
      const evq = { mint: q.mint, pool: q.pool, bondingCurveKey: q.bondingCurveKey, vSol: q.curve?.vSol ?? 0, vTokens: q.curve?.vTokens ?? 0, sol: q.price, tokens: 1 };
      ev = { ...(ev ?? { kind: "trade", ts: q.ts, wallet: "", side: "buy", newTokenBalance: 0, marketCapSol: 0, signature: "" }), ...evq } as Extract<FeedEvent, { kind: "trade" }>;
      if (this.inflight.has(`buy:${ev.mint}`)) return;
      const open = [...this.liveLedger.lots.values()];
      const standing = (standingOverride ?? this.st.follows[a.via]?.standing ?? 0.5) * mult;
      const pol = pctOverride !== undefined ? { ...P, maxPositionPct: pctOverride } : P;
      const openCost = open.reduce((x, l) => x + l.costSol, 0);
      // 지갑 SOL 이 목표 크기에 못 미치면(USDC 로 잡힌 자본이라) 로컬 서명일 때 부족분만 USDC→SOL 스왑
      const eq0 = this.liveEquitySol();
      let want = eq0 * (pol.maxPositionPct / 100) * Math.max(0, standing);
      if (pol.maxPositionSol > 0) want = Math.min(want, pol.maxPositionSol);
      want = Math.min(want, eq0 * (pol.grossMaxPct / 100) - openCost);
      await this.ensureWalletSol(want + pol.reserveSol + pol.priorityFeeSol);
      const { sol, why } = liveBuySize(pol, this.liveEquitySol(), standing, this.liveSt.walletSol, openCost, open.length);
      if (!sol) { logger.info("[pumpfun] live buy skipped", { mint: ev.mint.slice(0, 8), why }); return; }
      this.inflight.add(`buy:${ev.mint}`);
      const solBefore = this.liveSt.walletSol;
      const balanceBefore = await tokenBalance(this.modeSt.walletPubkey!, ev.mint).catch(() => 0);
      try {
        const { signature } = await executeTrade(config.PUMPFUN_API_KEY, { action: "buy", mint: ev.mint, amount: sol, denominatedInSol: true, slippage: P.slippagePct, priorityFee: P.priorityFeeSol, pool: ev.pool === "pump" ? "pump" : "auto" });
        const tx = await waitForTx(signature, TX_TIMEOUT_MS);
        let tokens = 0, costSol = 0, ts = new Date().toISOString();
        if (tx) {
          const d = parseTxDeltas(tx, this.modeSt.walletPubkey!, ev.mint);
          if (!d.ok) { this.liveSt.stats.failed += 1; this.liveError = `buy ${ev.mint.slice(0, 8)} failed on-chain: ${d.err}`; logger.warn("[pumpfun] live buy failed", { signature, err: d.err }); return; }
          tokens = d.tokenDelta; costSol = -d.solDelta; ts = d.ts;
        }
        if (!(tokens > 0)) {
          // 확정 조회가 안 됐다 — "실패"로 단정하지 않고 잔고로 대조한다 (체결됐는데 장부에서 빠지는 게 최악)
          const balBefore = balanceBefore, balAfter = await tokenBalance(this.modeSt.walletPubkey!, ev.mint).catch(() => balBefore);
          const solAfter = await this.syncWallet();
          tokens = Math.max(0, balAfter - balBefore); costSol = Math.max(0, solBefore - solAfter);
          logger.warn("[pumpfun] live buy confirmed by balance, not by tx", { signature, tokens, costSol });
          if (!(tokens > 0)) { this.liveSt.stats.failed += 1; this.liveError = `buy ${ev.mint.slice(0, 8)}: unconfirmed and no balance change (${signature.slice(0, 12)}) — reconcile will adopt if it lands`; return; }
          if (!(costSol > 0)) costSol = sol; // 지갑 동기화가 늦었으면 주문액으로
        }
        const r = this.liveLedger.openFromFill({ mint: ev.mint, symbol: ev.mint.slice(0, 4), pool: ev.pool || "pump", bondingCurveKey: ev.bondingCurveKey, curve: ev.pool === "pump" && ev.vSol > 0 ? { vSol: ev.vSol, vTokens: ev.vTokens } : null, tokens, costSol, via: a.via, reason: a.reason, signature, ts });
        if ("error" in r) { logger.warn("[pumpfun] live lot open refused", { error: r.error }); return; }
        this.liveSt.stats.buys += 1;
        logger.warn("[pumpfun] LIVE BUY", { mint: ev.mint, sol: costSol, tokens, via: a.via.slice(0, 8), signature });
        this.emit("live-order", r.order);
      } catch (e) { this.liveSt.stats.failed += 1; this.liveError = `buy ${ev.mint.slice(0, 8)}: ${(e as Error).message}`; logger.warn("[pumpfun] live buy error", { error: this.liveError }); }
      finally { this.inflight.delete(`buy:${ev.mint}`); await this.syncWallet(); this.syncSubscriptions(); this.checkLiveDailyStop(); this.saveLive(); }
      return;
    }
    const lot = this.liveLedger.lots.get(a.lotId);
    if (!lot || this.inflight.has(`sell:${lot.id}`)) return;
    if (a.ladderAt !== undefined) { if ((lot.ladderDone ?? []).includes(a.ladderAt)) return; lot.ladderDone = [...(lot.ladderDone ?? []), a.ladderAt]; }
    const bo = this.sellBackoff.get(lot.id);
    if (bo && Date.now() < bo.nextAt) return;
    // 먼지·유령(평가액 0 포함) — 팔아 봐야 수수료가 더 든다. 체인에 안 보내고 장부에서만 지운다
    if (lot.markSol < P.dustSol) {
      const c = this.liveLedger.closeFromFill(lot.id, lot.tokens, 0, `dust write-off (${lot.markSol.toFixed(5)} SOL < ${P.dustSol}) — ${a.reason}`, "");
      if (!("error" in c)) logger.warn("[pumpfun] dust lot written off", { mint: lot.mint.slice(0,8), markSol: lot.markSol, tokens: lot.tokens });
      this.saveLive(); return;
    }
    this.inflight.add(`sell:${lot.id}`);
    const sellSolBefore = this.liveSt.walletSol;
    const sellBalanceBefore = await tokenBalance(this.modeSt.walletPubkey!, lot.mint).catch(() => lot.tokens);
    let sentSignature: string | null = null;
    try {
      const all = a.fraction >= 0.999;
      const tokens = all ? lot.tokens : lot.tokens * a.fraction;
      // 전량이면 "100%" — 먼지가 남지 않게 지갑의 실제 잔고 전부를 판다
      const { signature } = await executeTrade(config.PUMPFUN_API_KEY, { action: "sell", mint: lot.mint, amount: all ? "100%" : Math.floor(tokens), denominatedInSol: false, slippage: P.slippagePct, priorityFee: P.priorityFeeSol, pool: lot.pool === "pump" ? "pump" : "auto" });
      sentSignature = signature;
      const tx = await waitForTx(signature, TX_TIMEOUT_MS);
      let sold = 0, received = 0, ts = new Date().toISOString();
      if (tx) {
        const d = parseTxDeltas(tx, this.modeSt.walletPubkey!, lot.mint);
        if (!d.ok) { this.liveSt.stats.failed += 1; this.liveError = `sell ${lot.mint.slice(0, 8)} failed on-chain: ${d.err}`; logger.warn("[pumpfun] live sell failed", { signature, err: d.err }); return; }
        sold = -d.tokenDelta; received = d.solDelta; ts = d.ts;
      }
      if (!(sold > 0)) {
        const balAfter = await tokenBalance(this.modeSt.walletPubkey!, lot.mint).catch(() => sellBalanceBefore);
        const solAfter = await this.syncWallet();
        sold = Math.max(0, sellBalanceBefore - balAfter); received = Math.max(0, solAfter - sellSolBefore);
        logger.warn("[pumpfun] live sell confirmed by balance, not by tx", { signature, sold, received });
        if (!(sold > 0)) { this.noteSellFail(lot.id); this.liveError = `sell ${lot.mint.slice(0, 8)}: unconfirmed and no balance change (${signature.slice(0, 12)})`; return; }
      }
      const r = this.liveLedger.closeFromFill(lot.id, all ? lot.tokens : sold, received, a.reason, signature, ts);
      if ("error" in r) { logger.warn("[pumpfun] live lot close refused", { error: r.error }); return; }
      this.sellBackoff.delete(lot.id);
      this.liveSt.stats.sells += 1;
      logger.warn("[pumpfun] LIVE SELL", { mint: lot.mint, sol: received, pnlSol: r.order.pnlSol, pnlPct: r.order.pnlPct, reason: a.reason, signature });
      this.emit("live-order", r.order);
    } catch (e) {
      // 주문 호출이 실패로 답해도 체결됐을 수 있다 — 잔고로 한 번 더 본다
      this.noteSellFail(lot.id); this.liveError = `sell ${lot.mint.slice(0, 8)}: ${(e as Error).message}`; logger.warn("[pumpfun] live sell error", { error: this.liveError, signature: sentSignature });
      try {
        await new Promise((r) => setTimeout(r, 4_000));
        const balAfter = await tokenBalance(this.modeSt.walletPubkey!, lot.mint);
        if (balAfter < sellBalanceBefore * 0.5) { const solAfter = await this.syncWallet(); const r = this.liveLedger.closeFromFill(lot.id, sellBalanceBefore - balAfter, Math.max(0, solAfter - sellSolBefore), `${a.reason} (confirmed by balance after an error response)`, sentSignature ?? ""); if (!("error" in r)) { this.liveSt.stats.sells += 1; this.sellBackoff.delete(lot.id); logger.warn("[pumpfun] LIVE SELL (balance-confirmed after error)", { mint: lot.mint, pnlSol: r.order.pnlSol }); } }
      } catch { /* leave for reconcile */ }
    }
    finally { this.inflight.delete(`sell:${lot.id}`); await this.syncWallet(); this.syncSubscriptions(); this.checkLiveDailyStop(); this.saveLive(); }
  }
  private noteSellFail(lotId: string) {
    const b = this.sellBackoff.get(lotId) ?? { fails: 0, nextAt: 0 };
    b.fails += 1; b.nextAt = Date.now() + (b.fails >= 3 ? 5 * 60_000 : 60_000);
    this.sellBackoff.set(lotId, b); this.liveSt.stats.failed += 1;
  }
  /**
   * 체인 대조 — 지갑이 실제로 든 토큰 중 장부에 없는 것을 로트로 **편입**한다 (via "chain:adopted", 원가 = 지금 평가액).
   * 확정 조회 실패로 빠진 체결, 수동 매수, 에어드랍 전부 여기로 들어와 청산 규칙(손절·되돌림·시간 정지·개발자 매도)을 받는다.
   * 반대로 장부에는 있는데 지갑에 없는 로트(수동 매도 등)는 닫는다. 실모드에서 2분마다, 기동 때, 주문 실패 뒤.
   */
  async reconcileLive(): Promise<{ adopted: string[]; closed: string[] }> {
    const out = { adopted: [] as string[], closed: [] as string[] };
    if (!this.modeSt.walletPubkey) return out;
    let held: Array<{ mint: string; amount: number }>;
    try { held = await walletTokenBalances(this.modeSt.walletPubkey); } catch (e) { this.liveError = `reconcile: ${(e as Error).message}`; return out; }
    // 접미사로 거르지 않는다 — pump.fun 토큰이 전부 "…pump" 로 끝나지는 않는다 (실측: CvUX… 가 편입에서 빠졌다). 잔고 1 초과면 전부 본다
    const onChain = new Map(held.filter((h) => h.amount > 1).map((h) => [h.mint, h.amount]));
    // 이미 편입돼 있던 보호 종목은 장부에서 방출한다 — 팔지 않고 (수동 보유로) 봇 장부에서만 제거
    for (const lot of [...this.liveLedger.lots.values()]) if (this.isProtectedMint(lot.mint)) { this.liveLedger.closeFromFill(lot.id, lot.tokens, lot.markSol, "released — protected mint, held manually", ""); out.closed.push(lot.mint); }
    for (const lot of [...this.ledger.lots.values()]) if (this.isProtectedMint(lot.mint)) this.ledger.sell(lot.id, 1, "released — protected mint");
    for (const [mint, amount] of onChain) {
      if (this.isProtectedMint(mint)) continue; // 보호 종목은 편입하지 않는다 — 봇 장부 밖에 둔다 (수동 관리)
      const lots = this.liveLedger.lotsOf(mint);
      if (lots.length) continue;
      if (this.inflight.has(`buy:${mint}`)) continue;
      // 원가를 모른다 — pump.fun 시총(SOL)으로 지금 가치를 원가로 삼는다. 이후 손익은 편입 시점부터
      let price = 0, pool = "pump-amm", curveKey: string | null = null;
      try {
        const c = await communityDesk.coinBasics(mint);
        if (c) { pool = c.complete ? "pump-amm" : "pump"; curveKey = c.bondingCurve; price = c.marketCapSol / 1_000_000_000; }
      } catch { /* unknown */ }
      if (!(price > 0) && curveKey) { try { const cv = await readCurve(curveKey); if (cv) price = cv.vSol / cv.vTokens; } catch { /* unknown */ } }
      const costSol = price > 0 ? amount * price : 0; // 0 = 원가 모름 → 첫 마킹이 원가
      // 먼지는 편입하지 않는다 — 팔면 수수료가 받는 SOL 보다 커서 −100%대가 찍히고, 같은 토큰이 계속 재편입된다 (실측: qFr43n 20318 토큰 = 0.0004 SOL)
      if (price > 0 && costSol < this.liveSt.policy.dustSol) { logger.info("[pumpfun] skip adopting dust", { mint: mint.slice(0, 8), costSol }); continue; }
      const r = this.liveLedger.openFromFill({ mint, symbol: mint.slice(0, 4), pool, bondingCurveKey: curveKey, curve: null, tokens: amount, costSol, via: "chain:adopted", reason: `adopted from wallet balance (${amount.toFixed(0)} tokens, cost unknown → ${costSol > 0 ? `marked at ${costSol.toFixed(4)} SOL` : "first mark becomes cost"})`, signature: "" });
      if (!("error" in r)) { out.adopted.push(mint); logger.warn("[pumpfun] adopted untracked position from chain", { mint, amount, costSol }); }
    }
    for (const lot of [...this.liveLedger.lots.values()]) {
      // 이전 빌드가 적은 가짜 원가(1e-6) 복구 — 원가 모름으로 되돌려 첫 마킹이 원가가 되게
      if (lot.via === "chain:adopted" && lot.costSol > 0 && lot.costSol <= 0.00001) { lot.costSol = 0; lot.lastPrice = 0; lot.markSol = 0; }
      if (lot.pool && !onChain.has(lot.mint) && !this.inflight.has(`sell:${lot.id}`)) {
        // 목록에 없다고 바로 닫지 않는다 — 그 mint 잔고를 한 번 더 직접 묻는다 (RPC 가 빈 목록을 줄 수 있다)
        let bal = 0; try { bal = await tokenBalance(this.modeSt.walletPubkey, lot.mint); } catch { continue; }
        if (bal > 1) continue;
        // 체인에서 팔렸는데 우리가 확인을 놓친 것 — 받은 SOL 은 모른다. 마지막 평가액으로 추정해 적고 그렇게 표시한다 (−100% 로 적으면 귀속이 망가진다)
        const c = this.liveLedger.closeFromFill(lot.id, lot.tokens, lot.markSol, "sold on-chain outside confirmation — proceeds estimated at last mark", "");
        if (!("error" in c)) { out.closed.push(lot.mint); this.liveSt.stats.sells += 1; }
      }
    }
    // 잘못 울린 일 손실 정지 — 편입·마킹 뒤 진짜 드로다운이 정지선보다 5%p 이상 여유면 자동 재개 (실측: 확인 실패로 두 번 잘못 울렸다)
    if (this.st.paused && this.st.pausedReason?.startsWith("LIVE daily stop")) {
      const eq = this.liveEquitySol(); const d = this.liveSt.day; const dd = d.startEquitySol > 0 ? ((d.startEquitySol - eq) / d.startEquitySol) * 100 : 0;
      if (dd < this.liveSt.policy.dailyStopPct - 5) { logger.warn("[pumpfun] daily stop was a false alarm after reconcile — resuming", { ddPct: +dd.toFixed(2) }); this.st.paused = false; this.st.pausedAt = null; this.st.pausedReason = null; this.syncSubscriptions(); this.save(); }
    }
    if (out.adopted.length || out.closed.length) { this.syncSubscriptions(); this.saveLive(); }
    return out;
  }
  private checkLiveDailyStop() {
    if (this.st.paused || this.modeSt.mode !== "real" || !(this.liveSt.policy.dailyStopPct > 0)) return;
    const eq = this.liveEquitySol(); const d = this.liveSt.day;
    if (d.date !== today()) { this.liveSt.day = { date: today(), startEquitySol: eq }; return; }
    const dd = d.startEquitySol > 0 ? ((d.startEquitySol - eq) / d.startEquitySol) * 100 : 0;
    if (this.liveSt.policy.dailyStopPct > 0 && dd >= this.liveSt.policy.dailyStopPct) this.pause(`LIVE daily stop: -${dd.toFixed(1)}% since ${d.date}`);
  }
  /** 실모드 전환 — owner가 화면에서 "REAL"을 타이핑. 켜는 순간 키·지갑을 검증한다 */
  async setMode(mode: PumpMode, by: string, walletPubkey?: string): Promise<{ error?: string; walletSol?: number }> {
    if (mode === "paper") { this.modeSt = { ...this.modeSt, mode: "paper", since: new Date().toISOString(), by }; this.saveLive(); logger.warn("[pumpfun] mode → paper", { by }); return {}; }
    if (!this.feed.hasKey && !hasSigner()) return { error: "PUMPFUN_API_KEY(Lightning) 또는 PUMPFUN_WALLET_SECRET(로컬 서명) 중 하나가 있어야 실주문이 나간다" };
    // 로컬 서명이면 지갑은 그 키의 공개키다 — pubkey 를 안 넣어도 서명키에서 채운다
    const pk = (walletPubkey ?? this.modeSt.walletPubkey ?? signerPubkey() ?? "").trim();
    if (!isSolanaAddress(pk)) return { error: "거래 지갑 공개키가 필요하다 (PumpPortal 설정 페이지의 wallet public key, 또는 PUMPFUN_WALLET_PUBKEY)" };
    if (hasSigner() && signerPubkey() && pk !== signerPubkey()) return { error: `공개키(${pk.slice(0, 6)}…)가 로컬 서명키의 지갑(${signerPubkey()!.slice(0, 6)}…)과 다르다` };
    let bal: number;
    try { bal = await walletSol(pk); } catch (e) { return { error: `지갑 잔고 조회 실패: ${(e as Error).message}` }; }
    if (bal < this.liveSt.policy.minWalletSol) {
      // 로컬 서명이면 USDC 를 SOL 로 바꿔 쓸 수 있다 — 단 스왑 tx 가스로 최소한의 네이티브 SOL(0.003)은 있어야 한다
      const usdcOk = hasSigner() && bal >= 0.003 && (await usdcBalance(pk).catch(() => 0)) > 0;
      if (!usdcOk) return { error: `지갑 잔고 ${bal.toFixed(4)} SOL < 최소 ${this.liveSt.policy.minWalletSol} SOL${hasSigner() ? " (USDC 스왑에도 가스용 네이티브 SOL 이 최소 0.003 필요)" : ""}` };
    }
    this.modeSt = { mode: "real", since: new Date().toISOString(), by, walletPubkey: pk };
    this.liveSt.walletSol = bal; this.liveSt.syncedAt = new Date().toISOString();
    this.liveSt.day = { date: today(), startEquitySol: this.liveEquitySol() };
    this.saveLive();
    logger.warn("[pumpfun] mode → REAL", { by, wallet: pk, walletSol: bal });
    void this.reconcileLive();
    return { walletSol: bal };
  }
  setLivePolicy(patch: Partial<LivePolicy>): LivePolicy {
    const next = { ...this.liveSt.policy };
    for (const [k, v] of Object.entries(patch)) if (typeof v === "number" && Number.isFinite(v) && k in next) (next as unknown as Record<string, number>)[k] = v;
    this.liveSt.policy = next; this.saveLive(); return next;
  }
  /** 실보유 전량 청산 + 정지 — 킬스위치 */
  async flattenLive(reason = "operator flatten"): Promise<{ sold: number; pending: number }> {
    this.pause(reason);
    const lots = [...this.liveLedger.lots.values()];
    await Promise.all(lots.map((l) => this.applyLive({ type: "sell", lotId: l.id, fraction: 1, reason })));
    return { sold: lots.length - this.liveLedger.lots.size, pending: this.liveLedger.lots.size };
  }
  liveStatus() {
    const eq = this.liveEquitySol();
    return {
      mode: this.modeSt.mode, since: this.modeSt.since, by: this.modeSt.by, walletPubkey: this.modeSt.walletPubkey, hasKey: this.feed.hasKey,
      localSign: hasSigner(), execVia: hasSigner() ? "local" : (this.feed.hasKey ? "lightning" : "none"),
      walletSol: +this.liveSt.walletSol.toFixed(6), usdc: +this.liveSt.usdc.toFixed(4), solUsd: this.liveSt.solUsd, usdcInSol: +this.usdcInSol().toFixed(6), syncedAt: this.liveSt.syncedAt, equitySol: +eq.toFixed(6), positionsSol: +this.liveLedger.positionsSol().toFixed(6),
      day: this.liveSt.day, dayPct: this.liveSt.day.startEquitySol > 0 ? +(((eq - this.liveSt.day.startEquitySol) / this.liveSt.day.startEquitySol) * 100).toFixed(2) : 0,
      policy: this.liveSt.policy, stats: this.liveSt.stats, inflight: [...this.inflight], error: this.liveError,
      lots: [...this.liveLedger.lots.values()].map((l) => ({ ...l, curve: undefined, pnlPct: l.costSol > 0 ? +(((l.markSol - l.costSol) / l.costSol) * 100).toFixed(2) : 0, holdMin: +((Date.now() - Date.parse(l.openedAt)) / 60_000).toFixed(1), community: this.communityOf(l.mint) })),
      orders: this.liveLedger.orders.slice(-50).reverse(),
    };
  }

  private quoteFromEvent(ev: Extract<FeedEvent, { kind: "trade" }>): BuyQuote {
    return { mint: ev.mint, pool: ev.pool || "pump", bondingCurveKey: ev.bondingCurveKey, curve: ev.pool === "pump" && ev.vSol > 0 ? { vSol: ev.vSol, vTokens: ev.vTokens } : null, price: ev.tokens > 0 ? ev.sol / ev.tokens : 0, ts: ev.ts };
  }
  /** 스트림이 없는 후보는 무료 스냅샷의 시총으로 견적 — AMM 가정 임팩트를 문다 */
  private quoteFromCandidate(mint: string): BuyQuote | null {
    const c = this.screen.get(mint); const s = c?.snaps[c.snaps.length - 1];
    if (!s || !(s.marketCapSol > 0)) return null;
    return { mint, pool: s.complete ? "pump-amm" : "pump", bondingCurveKey: null, curve: null, price: s.marketCapSol / 1_000_000_000, ts: new Date().toISOString() };
  }
  private apply(a: CopyAction, ev?: Extract<FeedEvent, { kind: "trade" }>): string | void {
    if (a.type === "skip") return;
    if (a.type === "buy") {
      const q = ev ? this.quoteFromEvent(ev) : this.lastQuote.get(a.mint) ?? this.quoteFromCandidate(a.mint);
      if (!q) { logger.warn("[pumpfun] paper buy: no quote", { mint: a.mint }); return; }
      const r = this.ledger.buy({ mint: q.mint, symbol: this.screen.get(q.mint)?.symbol ?? q.mint.slice(0, 4), pool: q.pool, bondingCurveKey: q.bondingCurveKey, curve: q.curve, price: q.price, solIn: a.solIn, via: a.via, reason: a.reason, ts: q.ts });
      if ("error" in r) { logger.warn("[pumpfun] paper buy refused", { mint: q.mint, error: r.error }); return; }
      this.st.stats.copies += 1;
      logger.info("[pumpfun] paper buy", { mint: q.mint, sol: a.solIn, via: a.via.slice(0, 8), impactPct: r.order.impactPct });
      this.emit("order", r.order); this.save();
      return r.lot.id;
    }
    const lot = this.ledger.lots.get(a.lotId);
    if (!lot) return;
    if (a.ladderAt !== undefined) lot.ladderDone = [...(lot.ladderDone ?? []), a.ladderAt];
    const r = this.ledger.sell(a.lotId, a.fraction, a.reason, ev?.ts);
    if ("error" in r) { logger.warn("[pumpfun] sell refused", { lotId: a.lotId, error: r.error }); return; }
    this.st.stats.exits += 1;
    // 귀속 — 로트가 닫히면 그 지갑의 standing 이 움직인다. 복합 로트면 진입에 표를 낸 엔진들의 가중치가 움직인다
    if (r.closed && r.order.pnlPct !== undefined && lot.via === "rule:ensemble") {
      const votes = this.st.entryVotes?.[lot.id];
      if (votes) { this.st.engineWeights = attribute(this.st.engineWeights ?? DEFAULT_ENGINE_WEIGHTS, votes, r.order.pnlPct); delete this.st.entryVotes![lot.id]; logger.info("[pumpfun] engine weights updated", { pnlPct: r.order.pnlPct, weights: this.st.engineWeights }); }
    }
    if (r.closed && r.order.pnlPct !== undefined) {
      const f = this.st.follows[lot.via];
      if (f) {
        const { follow, drop } = applyOutcome(f, r.order.pnlPct, this.st.policy);
        this.st.follows[lot.via] = follow;
        if (drop && follow.source !== "manual") { delete this.st.follows[lot.via]; logger.info("[pumpfun] wallet dropped — starved", { wallet: lot.via.slice(0, 8), cumPct: follow.cumPct, closes: follow.closes }); this.syncSubscriptions(); }
      }
      if (!this.ledger.lotsOf(lot.mint).length && !this.st.discovery[lot.mint]) this.feed.unsubscribeTokens([lot.mint]);
    }
    logger.info("[pumpfun] sell", { mint: lot.mint, reason: a.reason, pnlSol: r.order.pnlSol, pnlPct: r.order.pnlPct });
    this.emit("order", r.order);
    this.checkDailyStop();
    this.save();
  }

  // ===== 주기 =====
  private async tick() {
    // 날짜 경계 — 일 손실 기준 갱신
    const d = today();
    if (this.st.day.date !== d) { this.st.day = { date: d, startEquitySol: this.ledger.equitySol() }; }
    // 보유 커브 로트는 매 틱(15초) 무료 RPC로 커브 계정을 읽어 마킹한다 — 유료 거래 스트림을 구독하지 않아도 평가·손절이 돈다
    const stale = [...this.ledger.lots.values(), ...this.liveLedger.lots.values()].filter((l) => l.pool === "pump" && l.bondingCurveKey && Date.now() - Date.parse(l.markAt) > MARK_STALE_MS);
    const keys = [...new Set(stale.map((l) => l.bondingCurveKey!))].slice(0, 12);
    for (const key of keys) {
      try {
        const c = await readCurve(key);
        const mint = stale.find((l) => l.bondingCurveKey === key)!.mint;
        const arg = !c || c.complete ? { pool: "pump-amm" } : { curve: c, pool: "pump" }; // 계정이 없거나 완료 = 이주됨
        this.ledger.mark(mint, arg); this.liveLedger.mark(mint, arg);
      } catch (e) { this.lastError = (e as Error).message; }
    }
    for (const a of lotExits([...this.ledger.lots.values()], this.st.policy)) this.apply(a);
    if (this.modeSt.mode === "real") for (const a of lotExits([...this.liveLedger.lots.values()], this.st.policy)) void this.applyLive(a);
    this.syncSubscriptions();
    this.checkDailyStop();
  }
  private checkDailyStop() {
    if (this.st.paused) return;
    const eq = this.ledger.equitySol();
    const dd = this.st.day.startEquitySol > 0 ? ((this.st.day.startEquitySol - eq) / this.st.day.startEquitySol) * 100 : 0;
    if (this.st.policy.dailyStopPct > 0 && dd >= this.st.policy.dailyStopPct) { this.pause(`daily stop: -${dd.toFixed(1)}% since ${this.st.day.date}`); }
  }
  private snapshotEquity() {
    const eq = this.ledger.equitySol();
    this.appendJsonl(EQUITY_FILE, { ts: new Date().toISOString(), equitySol: +eq.toFixed(6), cashSol: +this.ledger.cashSol.toFixed(6), lots: this.ledger.lots.size, follows: Object.keys(this.st.follows).length });
    if (this.modeSt.mode === "real") { this.appendJsonl(LIVE_EQUITY_FILE, { ts: new Date().toISOString(), equitySol: +this.liveEquitySol().toFixed(6), cashSol: +this.liveSt.walletSol.toFixed(6), lots: this.liveLedger.lots.size }); this.saveLive(); }
    this.save();
  }

  /** 관측 거래로 지갑을 채점하고 추종 목록을 갱신 (수동 시드는 유지) */
  rescore(): { ranked: WalletStats[]; eligible: WalletStats[]; provisional: WalletStats[]; at: string } {
    const cutoff = Date.now() - TRADE_BUFFER_H * 3_600_000;
    this.trades = this.trades.filter((t) => Date.parse(t.ts) >= cutoff);
    const r = scoreWallets(this.trades, this.st.thresholds);
    this.lastScore = { ...r, at: new Date().toISOString() };
    this.st.lastRescoreAt = this.lastScore.at;
    const manual = new Set(this.st.seeds);
    const room = Math.max(0, this.st.policy.followMax - manual.size);
    const top = r.eligible.filter((w) => !isBlockedWallet(w.wallet)).slice(0, room);
    const topScore = top[0]?.score ?? 0;
    // 정식 자격이 모자라면 잠정 지갑으로 절반까지 채운다 — 작게 시작하고 실기록이 결정한다
    const provRoom = Math.max(0, Math.min(Math.floor(this.st.policy.followMax / 2), room - top.length));
    const prov = r.provisional.filter((w) => !isBlockedWallet(w.wallet)).slice(0, provRoom);
    const keep = new Set<string>([...manual, ...top.map((w) => w.wallet), ...prov.map((w) => w.wallet)]);
    // 이미 추종 중이고 실기록이 있는 지갑은 채점에서 빠졌어도 유지 — 실기록(standing)이 판단한다. 굶으면 applyOutcome이 뺀다
    // 실기록이 있는 지갑은 채점에서 빠졌어도 유지 — 단 누적이 양수일 때만. 실측: 누적 −47% 지갑이 이 규칙으로 살아남아 11번을 더 따라갔다
    for (const [w, f] of Object.entries(this.st.follows)) if (f.closes > 0 && f.cumPct > 0 && keep.size < this.st.policy.followMax) keep.add(w);
    for (const w of Object.keys(this.st.follows)) if (!keep.has(w)) delete this.st.follows[w];
    for (const w of top) if (!this.st.follows[w.wallet]) this.st.follows[w.wallet] = { wallet: w.wallet, standing: initialStanding(w, topScore), since: this.lastScore.at, source: "scored", closes: 0, wins: 0, cumPct: 0, returns: [] };
    for (const w of prov) if (!this.st.follows[w.wallet]) this.st.follows[w.wallet] = { wallet: w.wallet, standing: PROVISIONAL_STANDING, since: this.lastScore.at, source: "scored", closes: 0, wins: 0, cumPct: 0, returns: [] };
    this.syncSubscriptions();
    this.save();
    logger.info("[pumpfun] rescored", { trades: this.trades.length, wallets: r.ranked.length, eligible: r.eligible.length, provisional: r.provisional.length, following: Object.keys(this.st.follows).length });
    return this.lastScore;
  }

  // ===== 운영 =====
  pause(reason: string) { this.st.paused = true; this.st.pausedAt = new Date().toISOString(); this.st.pausedReason = reason; logger.warn("[pumpfun] paused", { reason }); this.syncSubscriptions(); this.save(); }
  resume() { this.st.paused = false; this.st.pausedAt = null; this.st.pausedReason = null; this.st.day = { date: today(), startEquitySol: this.ledger.equitySol() }; this.syncSubscriptions(); this.save(); }
  addSeed(wallet: string) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new Error("not a Solana address");
    if (isBlockedWallet(wallet)) throw new Error("curated block list — see backend/src/pumpfun/curated.ts");
    if (!this.st.seeds.includes(wallet)) this.st.seeds.push(wallet);
    if (!this.st.follows[wallet]) this.st.follows[wallet] = { wallet, standing: 0.5, since: new Date().toISOString(), source: "manual", closes: 0, wins: 0, cumPct: 0, returns: [] };
    else this.st.follows[wallet].source = "manual";
    this.syncSubscriptions(); this.save();
  }
  removeWallet(wallet: string) { this.st.seeds = this.st.seeds.filter((w) => w !== wallet); delete this.st.follows[wallet]; this.syncSubscriptions(); this.save(); }
  setPolicy(patch: Partial<CopyPolicy> & Partial<EnsemblePolicy> & { communityMinScore?: number; communityGate?: number }): CopyPolicy {
    const next = { ...this.st.policy };
    for (const [k, v] of Object.entries(patch)) { if (typeof v === "number" && Number.isFinite(v) && k in next) (next as unknown as Record<string, number>)[k] = v; }
    if (typeof patch.communityMinScore === "number") communityDesk.policy = { ...communityDesk.policy, minScore: patch.communityMinScore };
    if (typeof patch.communityGate === "number") communityDesk.policy = { ...communityDesk.policy, gate: patch.communityGate };
    const ens = { ...(this.st.ensemble ?? DEFAULT_ENSEMBLE_POLICY) } as unknown as Record<string, number>;
    for (const k of Object.keys(DEFAULT_ENSEMBLE_POLICY)) { const v = (patch as Record<string, unknown>)[k]; if (typeof v === "number" && Number.isFinite(v)) ens[k] = v; }
    this.st.ensemble = ens as unknown as EnsemblePolicy;
    this.st.community = communityDesk.policy;
    this.st.policy = next; this.save(); return next;
  }
  reset(startSol = config.PUMPFUN_PAPER_START_SOL) {
    this.ledger = new PumpLedger(startSol, this.st.costs);
    for (const f of Object.values(this.st.follows)) { f.closes = 0; f.wins = 0; f.cumPct = 0; f.returns = []; f.standing = f.source === "manual" ? 0.5 : f.standing; }
    this.st.stats.copies = 0; this.st.stats.exits = 0;
    this.st.day = { date: today(), startEquitySol: startSol };
    try { if (existsSync(EQUITY_FILE)) writeFileSync(EQUITY_FILE, ""); } catch { /* ignore */ }
    this.save();
    return { startSol, since: this.ledger.since };
  }

  // ===== 조회 =====
  status() {
    const eq = this.ledger.equitySol();
    const lots = [...this.ledger.lots.values()].map((l) => ({ ...l, curve: undefined, pnlPct: l.costSol > 0 ? +(((l.markSol - l.costSol) / l.costSol) * 100).toFixed(2) : 0, holdMin: +((Date.now() - Date.parse(l.openedAt)) / 60_000).toFixed(1), progress: l.curve ? +progress(l.curve).toFixed(3) : null, community: this.communityOf(l.mint) }));
    return {
      enabled: this.enabled, mode: this.modeSt.mode, unit: "SOL",
      live: this.liveStatus(),
      feed: this.feed.status(),
      ledger: { startSol: this.ledger.startSol, since: this.ledger.since, cashSol: +this.ledger.cashSol.toFixed(6), positionsSol: +this.ledger.positionsSol().toFixed(6), equitySol: +eq.toFixed(6), returnPct: this.ledger.startSol > 0 ? +(((eq - this.ledger.startSol) / this.ledger.startSol) * 100).toFixed(2) : 0, lots, day: this.st.day, dayPct: this.st.day.startEquitySol > 0 ? +(((eq - this.st.day.startEquitySol) / this.st.day.startEquitySol) * 100).toFixed(2) : 0 },
      follows: Object.values(this.st.follows).map((f) => ({ ...f, returns: undefined, hitRate: f.closes ? +(f.wins / f.closes).toFixed(2) : null, openLots: [...this.ledger.lots.values()].filter((l) => l.via === f.wallet).length })).sort((a, b) => b.standing - a.standing),
      seeds: this.st.seeds,
      protectedMints: [...this.protectedMints, ...(launchDesk.ownMint() ? [launchDesk.ownMint()] : [])],
      paused: this.st.paused, pausedAt: this.st.pausedAt, pausedReason: this.st.pausedReason,
      policy: this.st.policy, thresholds: this.st.thresholds, costs: this.st.costs,
      discovery: Object.entries(this.st.discovery).map(([mint, d]) => ({ mint, until: d.until })),
      tradeBuffer: { trades: this.trades.length, hours: TRADE_BUFFER_H, wallets: this.lastScore?.ranked.length ?? null, eligible: this.lastScore?.eligible.length ?? null, provisional: this.lastScore?.provisional.length ?? null, lastRescoreAt: this.st.lastRescoreAt },
      budget: { msgsPerDay: this.st.policy.meteredBudgetMsgsPerDay, solPerDay: +(this.st.policy.meteredBudgetMsgsPerDay * 0.01 / 10_000).toFixed(4), overBudget: this.overBudget() },
      ensemble: this.ensembleStatus(),
      community: { policy: communityDesk.policy, stats: communityDesk.stats, recent: communityDesk.recentReads(12).map((r) => ({ mint: r.facts.mint, symbol: r.facts.symbol, score: r.score, multiplier: r.multiplier, block: r.block, unknown: r.unknown, reasons: r.reasons, at: r.facts.fetchedAt, replyCount: r.facts.replyCount, telegramMembers: r.facts.telegramMembers, isLive: r.facts.isLive })) },
      stats: this.st.stats,
      recentCreates: this.recentCreates.slice(-20).reverse(),
      recentMigrations: this.recentMigrations.slice(-20).reverse(),
      orders: this.ledger.orders.slice(-30).reverse(),
      lastError: this.lastError,
    };
  }
  private communityOf(mint: string) { const r = communityDesk.cached(mint); return r ? { score: r.score, multiplier: r.multiplier, unknown: r.unknown, reasons: r.reasons, replyCount: r.facts.replyCount, telegramMembers: r.facts.telegramMembers, isLive: r.facts.isLive, creator: r.facts.creator } : null; }
  candidates(limit = 50) { const s = this.lastScore ?? this.rescoreView(); return { at: s.at, ranked: s.ranked.slice(0, limit), eligible: s.eligible.slice(0, limit), provisional: s.provisional.slice(0, limit), thresholds: this.st.thresholds, trades: this.trades.length }; }
  private rescoreView() { const r = scoreWallets(this.trades, this.st.thresholds); return { ...r, at: new Date().toISOString() }; }
  orders(limit = 200) { return this.ledger.orders.slice(-limit).reverse(); }
  events(limit = 100, kind?: FeedEvent["kind"]) { const list = kind ? this.recent.filter((e) => e.kind === kind) : this.recent; return list.slice(-limit).reverse(); }
  equity(limit = 2000, live = false): Array<{ ts: string; equitySol: number; cashSol: number; lots: number }> {
    const file = live ? LIVE_EQUITY_FILE : EQUITY_FILE;
    try { if (!existsSync(file)) return []; const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean); return lines.slice(-limit).map((l) => JSON.parse(l)); } catch { return []; }
  }
}

export const pumpfunDesk = new PumpfunDesk();
