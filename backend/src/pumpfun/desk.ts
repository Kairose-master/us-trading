import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { PumpPortalFeed, type FeedEvent } from "./feed.js";
import { PumpLedger, DEFAULT_LEDGER_COSTS, type LedgerCosts, type LedgerSnapshot } from "./ledger.js";
import { applyOutcome, lotExits, onLeaderTrade, DEFAULT_COPY_POLICY, type CopyAction, type CopyPolicy, type Follow } from "./copy.js";
import { initialStanding, scoreWallets, DEFAULT_THRESHOLDS, type ScoreThresholds, type WalletStats, type WalletTrade } from "./wallets.js";
import { readCurve } from "./solana-rpc.js";
import { progress } from "./curve.js";

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
const EQUITY_SNAPSHOT_MS = 5 * 60_000;
const MARK_STALE_MS = 60_000;
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
}

const today = () => new Date().toISOString().slice(0, 10);

class PumpfunDesk extends EventEmitter {
  enabled = config.PUMPFUN_ENABLED;
  feed = new PumpPortalFeed(config.PUMPFUN_WS_URL, config.PUMPFUN_API_KEY);
  ledger: PumpLedger;
  private st: State;
  /** 최근 48h 관측 거래 (지갑 채점용) */
  private trades: WalletTrade[] = [];
  private lastScore: { ranked: WalletStats[]; eligible: WalletStats[]; at: string } | null = null;
  private timers: NodeJS.Timeout[] = [];
  lastError: string | null = null;
  /** 이벤트 링 — 화면용 */
  private recent: FeedEvent[] = [];
  private recentCreates: Array<Extract<FeedEvent, { kind: "create" }>> = [];
  private recentMigrations: Array<Extract<FeedEvent, { kind: "migrate" }>> = [];

  constructor() {
    super();
    const restored = this.readState();
    const seeds = [...new Set([...(restored?.seeds ?? []), ...config.PUMPFUN_SEED_WALLETS])];
    this.st = restored ?? { ledger: new PumpLedger(config.PUMPFUN_PAPER_START_SOL).snapshot(), follows: {}, seeds, paused: false, pausedAt: null, pausedReason: null, policy: DEFAULT_COPY_POLICY, thresholds: DEFAULT_THRESHOLDS, costs: DEFAULT_LEDGER_COSTS, discovery: {}, day: { date: today(), startEquitySol: config.PUMPFUN_PAPER_START_SOL }, lastRescoreAt: null, stats: { creates: 0, migrations: 0, tradesObserved: 0, copies: 0, exits: 0 } };
    this.st.seeds = seeds;
    this.st.policy = { ...DEFAULT_COPY_POLICY, ...this.st.policy };
    this.st.thresholds = { ...DEFAULT_THRESHOLDS, ...this.st.thresholds };
    this.st.costs = { ...DEFAULT_LEDGER_COSTS, ...this.st.costs };
    this.ledger = PumpLedger.restore(this.st.ledger, this.st.costs);
    for (const w of seeds) if (!this.st.follows[w]) this.st.follows[w] = { wallet: w, standing: 0.5, since: new Date().toISOString(), source: "manual", closes: 0, wins: 0, cumPct: 0, returns: [] };
    this.loadTradeBuffer();
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
      const tmp = `${STATE_FILE}.tmp`; writeFileSync(tmp, JSON.stringify(this.st)); renameSync(tmp, STATE_FILE);
    } catch (e) { logger.warn("[pumpfun] state save failed", { error: (e as Error).message }); }
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
    for (const t of this.timers) t.unref();
    logger.info("[pumpfun] desk started (paper, SOL)", { startSol: this.ledger.startSol, follows: Object.keys(this.st.follows).length, seeds: this.st.seeds.length, key: this.feed.hasKey });
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; this.feed.stop(); this.save(); }

  /** 추종 지갑·보유 토큰·발견 창 구독을 피드에 맞춘다 (재연결 때도 호출) */
  private syncSubscriptions() {
    if (!this.feed.hasKey) return;
    const wantAccounts = new Set(Object.keys(this.st.follows));
    const haveAccounts = new Set(this.feed.subscribedAccounts());
    this.feed.subscribeAccounts([...wantAccounts].filter((w) => !haveAccounts.has(w)));
    this.feed.unsubscribeAccounts([...haveAccounts].filter((w) => !wantAccounts.has(w)));
    const now = Date.now();
    for (const [mint, d] of Object.entries(this.st.discovery)) if (Date.parse(d.until) < now) delete this.st.discovery[mint];
    const wantTokens = new Set([...this.ledger.heldMints(), ...Object.keys(this.st.discovery)]);
    const haveTokens = new Set(this.feed.subscribedTokens());
    this.feed.subscribeTokens([...wantTokens].filter((m) => !haveTokens.has(m)));
    this.feed.unsubscribeTokens([...haveTokens].filter((m) => !wantTokens.has(m)));
  }

  // ===== 이벤트 =====
  private onEvent(ev: FeedEvent) {
    this.recent.push(ev); if (this.recent.length > 300) this.recent.shift();
    if (ev.kind === "create") {
      this.st.stats.creates += 1;
      this.recentCreates.push(ev); if (this.recentCreates.length > 100) this.recentCreates.shift();
      this.appendJsonl(join(DIR, `events-${today()}.jsonl`), { k: "c", ts: ev.ts, mint: ev.mint, sym: ev.symbol, creator: ev.creator, buySol: ev.initialBuySol, vSol: ev.vSol, mcap: ev.marketCapSol });
      return;
    }
    if (ev.kind === "migrate") {
      this.st.stats.migrations += 1;
      this.recentMigrations.push(ev); if (this.recentMigrations.length > 100) this.recentMigrations.shift();
      this.appendJsonl(join(DIR, `events-${today()}.jsonl`), { k: "m", ts: ev.ts, mint: ev.mint, pool: ev.pool });
      // 지갑 발견 창 — 졸업 토큰의 거래를 잠시 관측한다 (유료 스트림이라 창과 개수를 제한)
      if (this.feed.hasKey && Object.keys(this.st.discovery).length < this.st.policy.discoveryMaxMints) {
        this.st.discovery[ev.mint] = { until: new Date(Date.now() + this.st.policy.discoveryWindowMin * 60_000).toISOString(), symbol: "" };
        this.feed.subscribeTokens([ev.mint]);
      }
      this.ledger.mark(ev.mint, { pool: ev.pool || "pump-amm" });
      return;
    }
    // trade
    this.st.stats.tradesObserved += 1;
    const wt: WalletTrade = { wallet: ev.wallet, mint: ev.mint, side: ev.side, sol: ev.sol, tokens: ev.tokens, ts: ev.ts };
    this.trades.push(wt); this.appendJsonl(TRADES_FILE, wt);
    if (this.trades.length > 400_000) this.trades.splice(0, this.trades.length - 300_000);
    // 보유 토큰 마킹 — 커브면 이벤트가 실어 온 준비금(정확), AMM이면 체결가
    if (this.ledger.lotsOf(ev.mint).length) {
      const price = ev.tokens > 0 ? ev.sol / ev.tokens : 0;
      this.ledger.mark(ev.mint, ev.pool === "pump" && ev.vSol > 0 ? { curve: { vSol: ev.vSol, vTokens: ev.vTokens }, pool: "pump" } : { price, pool: ev.pool || "pump-amm" }, ev.ts);
    }
    // 추종 지갑이면 카피 규칙
    const follow = this.st.follows[ev.wallet];
    if (follow) {
      const actions = onLeaderTrade(ev, { policy: this.st.policy, follow, lots: [...this.ledger.lots.values()], equitySol: this.ledger.equitySol(), cashSol: this.ledger.cashSol, positionsSol: this.ledger.positionsSol(), paused: this.st.paused });
      for (const a of actions) this.apply(a, ev);
    }
    // 마킹 뒤 청산 규칙
    for (const a of lotExits(this.ledger.lotsOf(ev.mint), this.st.policy)) this.apply(a, ev);
  }

  private apply(a: CopyAction, ev?: Extract<FeedEvent, { kind: "trade" }>) {
    if (a.type === "skip") return;
    if (a.type === "buy") {
      if (!ev) return;
      const r = this.ledger.buy({ mint: ev.mint, symbol: ev.mint.slice(0, 4), pool: ev.pool || "pump", bondingCurveKey: ev.bondingCurveKey, curve: ev.pool === "pump" && ev.vSol > 0 ? { vSol: ev.vSol, vTokens: ev.vTokens } : null, price: ev.tokens > 0 ? ev.sol / ev.tokens : 0, solIn: a.solIn, via: a.via, reason: a.reason, ts: ev.ts });
      if ("error" in r) { logger.warn("[pumpfun] copy buy refused", { mint: ev.mint, error: r.error }); return; }
      this.st.stats.copies += 1;
      this.feed.subscribeTokens([ev.mint]);
      logger.info("[pumpfun] copy buy", { mint: ev.mint, sol: a.solIn, via: a.via.slice(0, 8), impactPct: r.order.impactPct });
      this.emit("order", r.order); this.save();
      return;
    }
    const lot = this.ledger.lots.get(a.lotId);
    if (!lot) return;
    const r = this.ledger.sell(a.lotId, a.fraction, a.reason, ev?.ts);
    if ("error" in r) { logger.warn("[pumpfun] sell refused", { lotId: a.lotId, error: r.error }); return; }
    this.st.stats.exits += 1;
    // 귀속 — 로트가 닫히면 그 지갑의 standing 이 움직인다
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
    // 오래 마킹 안 된 커브 로트는 RPC로 읽어 마킹 (스트림이 끊겨도 포지션이 정직하게 평가되도록)
    const stale = [...this.ledger.lots.values()].filter((l) => l.pool === "pump" && l.bondingCurveKey && Date.now() - Date.parse(l.markAt) > MARK_STALE_MS);
    const keys = [...new Set(stale.map((l) => l.bondingCurveKey!))].slice(0, 6);
    for (const key of keys) {
      try {
        const c = await readCurve(key);
        const mint = stale.find((l) => l.bondingCurveKey === key)!.mint;
        if (!c) { this.ledger.mark(mint, { pool: "pump-amm" }); continue; } // 계정이 없다 = 이주됨
        if (c.complete) { this.ledger.mark(mint, { pool: "pump-amm" }); continue; }
        this.ledger.mark(mint, { curve: c, pool: "pump" });
      } catch (e) { this.lastError = (e as Error).message; }
    }
    for (const a of lotExits([...this.ledger.lots.values()], this.st.policy)) this.apply(a);
    this.syncSubscriptions();
    this.checkDailyStop();
  }
  private checkDailyStop() {
    if (this.st.paused) return;
    const eq = this.ledger.equitySol();
    const dd = this.st.day.startEquitySol > 0 ? ((this.st.day.startEquitySol - eq) / this.st.day.startEquitySol) * 100 : 0;
    if (dd >= this.st.policy.dailyStopPct) { this.pause(`daily stop: -${dd.toFixed(1)}% since ${this.st.day.date}`); }
  }
  private snapshotEquity() {
    const eq = this.ledger.equitySol();
    this.appendJsonl(EQUITY_FILE, { ts: new Date().toISOString(), equitySol: +eq.toFixed(6), cashSol: +this.ledger.cashSol.toFixed(6), lots: this.ledger.lots.size, follows: Object.keys(this.st.follows).length });
    this.save();
  }

  /** 관측 거래로 지갑을 채점하고 추종 목록을 갱신 (수동 시드는 유지) */
  rescore(): { ranked: WalletStats[]; eligible: WalletStats[]; at: string } {
    const cutoff = Date.now() - TRADE_BUFFER_H * 3_600_000;
    this.trades = this.trades.filter((t) => Date.parse(t.ts) >= cutoff);
    const r = scoreWallets(this.trades, this.st.thresholds);
    this.lastScore = { ...r, at: new Date().toISOString() };
    this.st.lastRescoreAt = this.lastScore.at;
    const manual = new Set(this.st.seeds);
    const room = Math.max(0, this.st.policy.followMax - manual.size);
    const top = r.eligible.slice(0, room);
    const topScore = top[0]?.score ?? 0;
    const keep = new Set<string>([...manual, ...top.map((w) => w.wallet)]);
    // 이미 추종 중이고 실기록이 있는 지갑은 채점에서 빠졌어도 유지 — 실기록(standing)이 판단한다. 굶으면 applyOutcome이 뺀다
    for (const [w, f] of Object.entries(this.st.follows)) if (f.closes > 0 && keep.size < this.st.policy.followMax) keep.add(w);
    for (const w of Object.keys(this.st.follows)) if (!keep.has(w)) delete this.st.follows[w];
    for (const w of top) if (!this.st.follows[w.wallet]) this.st.follows[w.wallet] = { wallet: w.wallet, standing: initialStanding(w, topScore), since: this.lastScore.at, source: "scored", closes: 0, wins: 0, cumPct: 0, returns: [] };
    this.syncSubscriptions();
    this.save();
    logger.info("[pumpfun] rescored", { trades: this.trades.length, wallets: r.ranked.length, eligible: r.eligible.length, following: Object.keys(this.st.follows).length });
    return this.lastScore;
  }

  // ===== 운영 =====
  pause(reason: string) { this.st.paused = true; this.st.pausedAt = new Date().toISOString(); this.st.pausedReason = reason; logger.warn("[pumpfun] paused", { reason }); this.save(); }
  resume() { this.st.paused = false; this.st.pausedAt = null; this.st.pausedReason = null; this.st.day = { date: today(), startEquitySol: this.ledger.equitySol() }; this.save(); }
  addSeed(wallet: string) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new Error("not a Solana address");
    if (!this.st.seeds.includes(wallet)) this.st.seeds.push(wallet);
    if (!this.st.follows[wallet]) this.st.follows[wallet] = { wallet, standing: 0.5, since: new Date().toISOString(), source: "manual", closes: 0, wins: 0, cumPct: 0, returns: [] };
    else this.st.follows[wallet].source = "manual";
    this.syncSubscriptions(); this.save();
  }
  removeWallet(wallet: string) { this.st.seeds = this.st.seeds.filter((w) => w !== wallet); delete this.st.follows[wallet]; this.syncSubscriptions(); this.save(); }
  setPolicy(patch: Partial<CopyPolicy>): CopyPolicy {
    const next = { ...this.st.policy };
    for (const [k, v] of Object.entries(patch)) { if (typeof v === "number" && Number.isFinite(v) && k in next) (next as unknown as Record<string, number>)[k] = v; }
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
    const lots = [...this.ledger.lots.values()].map((l) => ({ ...l, curve: undefined, pnlPct: l.costSol > 0 ? +(((l.markSol - l.costSol) / l.costSol) * 100).toFixed(2) : 0, holdMin: +((Date.now() - Date.parse(l.openedAt)) / 60_000).toFixed(1), progress: l.curve ? +progress(l.curve).toFixed(3) : null }));
    return {
      enabled: this.enabled, mode: "paper" as const, unit: "SOL",
      feed: this.feed.status(),
      ledger: { startSol: this.ledger.startSol, since: this.ledger.since, cashSol: +this.ledger.cashSol.toFixed(6), positionsSol: +this.ledger.positionsSol().toFixed(6), equitySol: +eq.toFixed(6), returnPct: this.ledger.startSol > 0 ? +(((eq - this.ledger.startSol) / this.ledger.startSol) * 100).toFixed(2) : 0, lots, day: this.st.day, dayPct: this.st.day.startEquitySol > 0 ? +(((eq - this.st.day.startEquitySol) / this.st.day.startEquitySol) * 100).toFixed(2) : 0 },
      follows: Object.values(this.st.follows).map((f) => ({ ...f, returns: undefined, hitRate: f.closes ? +(f.wins / f.closes).toFixed(2) : null, openLots: [...this.ledger.lots.values()].filter((l) => l.via === f.wallet).length })).sort((a, b) => b.standing - a.standing),
      seeds: this.st.seeds,
      paused: this.st.paused, pausedAt: this.st.pausedAt, pausedReason: this.st.pausedReason,
      policy: this.st.policy, thresholds: this.st.thresholds, costs: this.st.costs,
      discovery: Object.entries(this.st.discovery).map(([mint, d]) => ({ mint, until: d.until })),
      tradeBuffer: { trades: this.trades.length, hours: TRADE_BUFFER_H, wallets: this.lastScore?.ranked.length ?? null, eligible: this.lastScore?.eligible.length ?? null, lastRescoreAt: this.st.lastRescoreAt },
      stats: this.st.stats,
      recentCreates: this.recentCreates.slice(-20).reverse(),
      recentMigrations: this.recentMigrations.slice(-20).reverse(),
      orders: this.ledger.orders.slice(-30).reverse(),
      lastError: this.lastError,
    };
  }
  candidates(limit = 50) { const s = this.lastScore ?? this.rescoreView(); return { at: s.at, ranked: s.ranked.slice(0, limit), eligible: s.eligible.slice(0, limit), thresholds: this.st.thresholds, trades: this.trades.length }; }
  private rescoreView() { const r = scoreWallets(this.trades, this.st.thresholds); return { ...r, at: new Date().toISOString() }; }
  orders(limit = 200) { return this.ledger.orders.slice(-limit).reverse(); }
  events(limit = 100, kind?: FeedEvent["kind"]) { const list = kind ? this.recent.filter((e) => e.kind === kind) : this.recent; return list.slice(-limit).reverse(); }
  equity(limit = 2000): Array<{ ts: string; equitySol: number; cashSol: number; lots: number }> {
    try { if (!existsSync(EQUITY_FILE)) return []; const lines = readFileSync(EQUITY_FILE, "utf-8").split("\n").filter(Boolean); return lines.slice(-limit).map((l) => JSON.parse(l)); } catch { return []; }
  }
}

export const pumpfunDesk = new PumpfunDesk();
