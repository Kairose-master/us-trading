import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { cryptoDesk } from "../crypto/desk.js";
import { upbit } from "../crypto/upbit.js";
import { riskManager } from "../risk/riskManager.js";
import { MANAGERS, convene, type CouncilResult, type SentimentRead } from "./council.js";

/**
 * 제어 평면 — 대시보드의 엔진들(스캐너·오피스·진화·파이프라인 신호)이 각자 장부를 덮어쓰던
 * 것을 끝낸다. 이제 엔진은 **제안(proposal)** 만 낸다. 여기서 하나의 목표 포트폴리오로
 * 합치고(엔진 가중치 × 확신도), 리스크 한도와 킬스위치를 지나, 자동조종이면 실행하고
 * 아니면 owner 승인을 기다린다. 실행 뒤에는 각 엔진의 제안이 실제로 어땠는지를 실현
 * 수익으로 추적해 엔진 가중치가 스스로 움직인다(지수 가중, quant/allocator와 같은 규칙).
 *
 * 돈 경계는 그대로: 실행은 cryptoDesk.rotateTo(페이퍼 전용, 실주문 모드면 거부)뿐이다.
 */

export type EngineId = "scanner" | "office" | "evolution" | "signals";
export const ENGINES: Array<{ id: EngineId; name: string; nameKo: string; description: string }> = [
  { id: "scanner", name: "Alt Scanner", nameKo: "알트 스캐너", description: "HMM 강세 belief·모멘텀/변동성·GARCH 역가중 상위 K 로테이션 (24h)" },
  { id: "office", name: "Securities Floor", nameKo: "증권 오피스", description: "Handsel 9역할 협의 → 채점 통과한 위원장 결정 JSON" },
  { id: "evolution", name: "Evolution Squad", nameKo: "진화 스쿼드", description: "본 적 없는 60일 시험에서 살아남은 상위 3 개체의 타깃 혼합" },
  { id: "signals", name: "Pipeline Signals", nameKo: "파이프라인 신호", description: "정형+비정형 DAG의 앙상블 알파 → 포트폴리오 타깃" },
];

export interface Target { market: string; weightPct: number }
export interface Proposal {
  id: string;
  engine: EngineId;
  ts: string;
  expiresAt: string;
  targets: Target[];
  confidence: number;
  evidence: string;
  ref: string | null;
}
export interface Decision {
  id: string;
  ts: string;
  status: "pending" | "executed" | "rejected" | "skipped" | "blocked";
  targets: Target[];
  cashPct: number;
  contributions: Array<{ engine: EngineId; weight: number; confidence: number; proposalId: string; targets: Target[] }>;
  rationale: string[];
  constraints: string[];
  turnoverPct: number;
  execution: { ts: string; orders: number; skipped: string[]; error?: string } | null;
  by: "autopilot" | "operator" | null;
  /** 협의록 — 매니저들의 입장·수정·표결. 구 결정에는 없다 */
  council?: Pick<CouncilResult, "rounds" | "tally" | "summary" | "quorumMet">;
}
export interface EngineState {
  id: EngineId;
  enabled: boolean;
  weight: number;
  lastProposal: Proposal | null;
  returns: number[];
  cumReturnPct: number;
  proposals: number;
}
interface State {
  autopilot: boolean;
  /** 지속 정지 — 운영자가 명시적으로 멈춘 상태. 재부팅·재배포에도 유지되고, 켜져 있으면 아무것도 집행되지 않는다 */
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  engines: Record<EngineId, EngineState>;
  proposals: Proposal[];
  decisions: Decision[];
  pending: Decision | null;
  lastExecutedAt: string | null;
  lastMarkedDate: string | null;
  policy: { maxWeightPct: number; maxPositions: number; cashFloorPct: number; grossMaxPct: number; minTurnoverPct: number; minIntervalMin: number; proposalTtlH: number; eta: number };
}

const FILE = join(process.cwd(), "data", "control", "state.json");
// 집행 간격 60분·최소 회전 8% — 15분마다 오는 신호 제안까지 전부 집행하면 장부가 잔거래로 오염된다 (2026-09-02 실제로 그랬다)
const DEFAULT_POLICY: State["policy"] = { maxWeightPct: 30, maxPositions: 8, cashFloorPct: 10, grossMaxPct: 90, minTurnoverPct: 8, minIntervalMin: 60, proposalTtlH: 30, eta: 8 };

function fresh(): State {
  const engines = Object.fromEntries(ENGINES.map((e) => [e.id, { id: e.id, enabled: true, weight: 1, lastProposal: null, returns: [], cumReturnPct: 0, proposals: 0 }])) as unknown as Record<EngineId, EngineState>;
  return { autopilot: config.CONTROL_AUTOPILOT, paused: false, pausedAt: null, pausedBy: null, engines, proposals: [], decisions: [], pending: null, lastExecutedAt: null, lastMarkedDate: null, policy: DEFAULT_POLICY };
}
function readState(): State {
  try {
    if (existsSync(FILE)) {
      const st = JSON.parse(readFileSync(FILE, "utf-8")) as State; st.policy = { ...DEFAULT_POLICY, ...st.policy }; const f = fresh(); for (const e of ENGINES) st.engines[e.id] ??= f.engines[e.id];
      // 오토파일럿은 부팅마다 env 기본값으로 — 사람 손 없이 돌아야 한다. 멈추려면 pause(지속)를 쓴다
      st.autopilot = config.CONTROL_AUTOPILOT; st.paused ??= false; st.pausedAt ??= null; st.pausedBy ??= null;
      return st;
    }
  } catch (e) { logger.warn("제어 평면 상태 복원 실패 — 새로 시작", { error: (e as Error).message }); }
  return fresh();
}

class ControlPlane extends EventEmitter {
  private st = readState();
  private priceOf: () => Map<string, number> = () => new Map();
  attachPrices(fn: () => Map<string, number>) { this.priceOf = fn; }
  private sentimentOf: () => SentimentRead[] = () => [];
  attachSentiment(fn: () => SentimentRead[]) { this.sentimentOf = fn; }
  private drawdownOf: () => number = () => 0;
  attachDrawdown(fn: () => number) { this.drawdownOf = fn; }

  private save() { mkdirSync(dirname(FILE), { recursive: true }); const tmp = `${FILE}.tmp`; writeFileSync(tmp, JSON.stringify(this.st)); renameSync(tmp, FILE); }
  private emitState() { this.emit("state", this.status()); }

  status() {
    const desk = cryptoDesk.status();
    const holdings = desk.positions.map((p) => ({ market: `KRW-${p.symbol}`, weightPct: desk.equityKrw > 0 ? +(((p.qty * p.curKrw) / desk.equityKrw) * 100).toFixed(2) : 0 }));
    const wsum = ENGINES.filter((e) => this.st.engines[e.id].enabled).reduce((a, e) => a + this.st.engines[e.id].weight, 0) || 1;
    const sinceLastMin = this.st.lastExecutedAt ? (Date.now() - Date.parse(this.st.lastExecutedAt)) / 60_000 : Infinity;
    return {
      autopilot: this.st.autopilot,
      paused: this.st.paused,
      pausedAt: this.st.pausedAt,
      pausedBy: this.st.pausedBy,
      /** 사람 없이 집행되는 상태인가 — 오토파일럿 ON, 정지 아님, 킬스위치 아님 */
      unattended: this.st.autopilot && !this.st.paused && !riskManager.killSwitchActive,
      scheduler: { everyMin: config.CONTROL_TICK_MIN, lastTickAt: this.lastTickAt, nextEligibleAt: Number.isFinite(sinceLastMin) ? new Date(Date.parse(this.st.lastExecutedAt!) + this.st.policy.minIntervalMin * 60_000).toISOString() : null },
      mode: desk.mode,
      killSwitch: riskManager.killSwitchActive,
      policy: this.st.policy,
      managers: MANAGERS.map((m) => { const e = ENGINES.some((x) => x.id === m.id) ? this.st.engines[m.id as EngineId] : null; return { ...m, enabled: e ? e.enabled : true, weight: e ? +e.weight.toFixed(4) : null, lastProposal: e?.lastProposal ?? null, cumReturnPct: e ? +e.cumReturnPct.toFixed(2) : null }; }),
      engines: ENGINES.map((e) => { const s = this.st.engines[e.id]; return { ...e, enabled: s.enabled, weight: +s.weight.toFixed(4), share: s.enabled ? +(s.weight / wsum).toFixed(3) : 0, lastProposal: s.lastProposal, proposals: s.proposals, cumReturnPct: +s.cumReturnPct.toFixed(2), days: s.returns.length }; }),
      proposals: this.activeProposals(),
      pending: this.st.pending,
      decisions: this.st.decisions.slice(0, 30),
      lastExecutedAt: this.st.lastExecutedAt,
      lastMarkedDate: this.st.lastMarkedDate,
      holdings,
      equityKrw: desk.equityKrw,
      cashKrw: desk.cashKrw,
    };
  }

  private activeProposals(): Proposal[] {
    const now = Date.now();
    this.st.proposals = this.st.proposals.filter((p) => Date.parse(p.expiresAt) > now);
    return this.st.proposals;
  }

  async propose(p: Omit<Proposal, "id" | "ts" | "expiresAt">): Promise<{ proposal: Proposal; decision: Decision | null }> {
    const proposal: Proposal = { ...p, id: `pr_${Date.now().toString(36)}_${p.engine}`, ts: new Date().toISOString(), expiresAt: new Date(Date.now() + this.st.policy.proposalTtlH * 3600_000).toISOString(), confidence: Math.max(0, Math.min(1, p.confidence)) };
    this.st.proposals = this.activeProposals().filter((x) => x.engine !== p.engine);
    this.st.proposals.push(proposal);
    const es = this.st.engines[p.engine];
    es.lastProposal = proposal; es.proposals++;
    logger.info("[control] proposal", { engine: p.engine, targets: p.targets.length, confidence: proposal.confidence, ref: p.ref });
    this.emit("proposal", proposal);
    const decision = await this.arbitrate("proposal");
    this.save(); this.emitState();
    return { proposal, decision };
  }

  async arbitrate(reason: string): Promise<Decision | null> {
    const props = this.activeProposals().filter((p) => this.st.engines[p.engine].enabled);
    if (props.length === 0) return null;
    const pol = this.st.policy;
    const contribs = props.map((p) => ({ engine: p.engine, weight: this.st.engines[p.engine].weight, confidence: p.confidence, proposalId: p.id, targets: p.targets }));
    // 협의회 — 매니저들이 시장별로 입장을 내고 수정하고 표결한다. 가중평균은 더 이상 없다
    const holdings = this.status().holdings;
    const council = convene({
      proposals: props.map((p) => ({ manager: p.engine, targets: p.targets, confidence: p.confidence, evidence: p.evidence, ageMin: (Date.now() - Date.parse(p.ts)) / 60_000 })),
      standing: ENGINES.map((e) => ({ id: e.id, name: e.name, nameKo: e.nameKo, weight: this.st.engines[e.id].weight, enabled: this.st.engines[e.id].enabled })),
      sentiment: this.sentimentOf(),
      risk: { killSwitch: riskManager.killSwitchActive, drawdownPct: this.drawdownOf(), policy: { maxWeightPct: pol.maxWeightPct, maxPositions: pol.maxPositions, cashFloorPct: pol.cashFloorPct, grossMaxPct: pol.grossMaxPct }, holdings },
    });
    const targets = council.targets;
    const gross = targets.reduce((a, t) => a + t.weightPct, 0);
    const constraints = [...council.constraints];
    const rationale = [...council.summary, ...council.tally.map((t) => `${t.market.replace("KRW-", "")}: ${t.outcome}${t.outcome === "ADOPTED" ? ` ${t.weightPct}%` : ""} — ${t.why}`)];
    if (riskManager.killSwitchActive) constraints.push("KILL SWITCH active — decision blocked");
    const cur = new Map(this.status().holdings.map((h) => [h.market, h.weightPct]));
    let turnover = 0;
    for (const m of new Set([...cur.keys(), ...targets.map((t) => t.market)])) turnover += Math.abs((targets.find((t) => t.market === m)?.weightPct ?? 0) - (cur.get(m) ?? 0));
    turnover /= 2;
    const decision: Decision = {
      id: `dc_${Date.now().toString(36)}`, ts: new Date().toISOString(), status: "pending", targets, cashPct: +(100 - gross).toFixed(2),
      contributions: contribs.map(({ engine, weight, confidence, proposalId, targets: tg }) => ({ engine, weight: +weight.toFixed(4), confidence, proposalId, targets: tg })),
      rationale, constraints, turnoverPct: +turnover.toFixed(2), execution: null, by: null,
      council: { rounds: council.rounds, tally: council.tally, summary: council.summary, quorumMet: council.quorumMet },
    };
    // 정족수 미달은 "아무것도 하지 않는다"이지 "다 판다"가 아니다. 현금으로 가는 건 리스크 총괄의 거부권뿐이다
    const vetoed = council.tally.some((t) => t.vetoed);
    if (!council.quorumMet && !vetoed) { decision.status = "skipped"; decision.rationale.push(holdings.length ? "council reached no quorum — holding the current book unchanged" : "council reached no quorum and the book is cash — nothing to do"); this.push(decision); return decision; }
    if (riskManager.killSwitchActive) { decision.status = "blocked"; decision.rationale.push("kill switch active"); this.push(decision); logger.warn("[control] blocked by kill switch"); return decision; }
    if (this.st.paused) { decision.status = "blocked"; decision.rationale.push(`paused by ${this.st.pausedBy ?? "operator"} at ${this.st.pausedAt ?? "?"} — resume to execute`); this.push(decision); logger.info("[control] blocked — paused"); return decision; }
    const sinceLast = this.st.lastExecutedAt ? (Date.now() - Date.parse(this.st.lastExecutedAt)) / 60_000 : Infinity;
    if (turnover < pol.minTurnoverPct) { decision.status = "skipped"; decision.rationale.push(`turnover ${turnover.toFixed(1)}% < ${pol.minTurnoverPct}% — nothing worth trading`); this.push(decision); return decision; }
    if (sinceLast < pol.minIntervalMin) { decision.rationale.push(`last execution ${sinceLast.toFixed(0)}m ago < ${pol.minIntervalMin}m — held as pending`); this.st.pending = decision; this.emit("pending", decision); return decision; }
    if (this.st.autopilot) return this.execute(decision, "autopilot", reason);
    this.st.pending = decision; this.emit("pending", decision);
    logger.info("[control] decision pending operator approval", { targets: targets.length, turnover });
    return decision;
  }

  private push(d: Decision) { this.st.decisions.unshift(d); if (this.st.decisions.length > 200) this.st.decisions.length = 200; this.emit("decision", d); }

  /** 데스크가 추적하지 않는 알트(스캐너·진화 유니버스)의 현재가는 여기서 직접 채운다 — 없으면 rotateTo가 그 종목을 건너뛰고 "현재가 없음"으로 남긴다. */
  private async pricesFor(targets: Target[]): Promise<Map<string, number>> {
    const prices = new Map(this.priceOf());
    const held = cryptoDesk.status().positions.map((p) => `KRW-${p.symbol}`);
    const missing = [...new Set([...targets.map((t) => t.market), ...held])].filter((m) => !(prices.get(m)! > 0));
    if (missing.length) {
      try {
        for (const t of await upbit.tickers(missing)) if (t.trade_price > 0) prices.set(t.market, t.trade_price);
      } catch (e) { logger.warn("[control] price fetch failed — 해당 종목은 건너뜀", { missing: missing.length, error: (e as Error).message }); }
    }
    return prices;
  }

  private async execute(decision: Decision, by: "autopilot" | "operator", reason: string): Promise<Decision> {
    const r = cryptoDesk.rotateTo(decision.targets, await this.pricesFor(decision.targets), `control plane ${by} — ${decision.contributions.map((c) => c.engine).join("+")} (${reason})`);
    decision.execution = { ts: new Date().toISOString(), orders: r.orders.length, skipped: r.skipped, ...(r.error ? { error: r.error } : {}) };
    decision.status = r.error ? "rejected" : "executed"; decision.by = by;
    // 제안은 집행 뒤에도 남는다 — 매니저의 마지막 입장이 TTL까지 협의회에 계속 앉아 있어야 정족수가 성립한다
    if (!r.error) this.st.lastExecutedAt = decision.execution.ts;
    // 집행된 결정이 보류 중이던 것을 대체한다 — 같은 id든 재중재로 새로 만든 것이든
    if (this.st.pending && this.st.pending.id !== decision.id && !r.error) { const old = this.st.pending; old.status = "skipped"; old.rationale.push(`superseded by ${decision.id}`); this.push(old); }
    if (!r.error || this.st.pending?.id === decision.id) this.st.pending = null;
    this.push(decision);
    logger.info("[control] executed", { by, orders: r.orders.length, error: r.error ?? null });
    this.save(); this.emitState();
    return decision;
  }

  approve(): Promise<Decision> { const d = this.st.pending; if (!d) throw new Error("승인 대기 결정 없음"); return this.execute(d, "operator", "approved"); }
  reject(): Decision { const d = this.st.pending; if (!d) throw new Error("승인 대기 결정 없음"); d.status = "rejected"; d.by = "operator"; this.st.pending = null; this.push(d); this.save(); this.emitState(); return d; }
  /** 장부가 초기화됐다 — 보류 결정·집행 시각을 비우고 정책을 기본값으로. 결정 로그와 엔진 귀속은 남긴다 (역사는 지우지 않는다) */
  onLedgerReset() {
    if (this.st.pending) { const d = this.st.pending; d.status = "skipped"; d.rationale.push("paper ledger reset — decision discarded"); this.st.pending = null; this.push(d); }
    this.st.lastExecutedAt = null;
    this.st.policy = { ...DEFAULT_POLICY };
    logger.warn("[control] ledger reset acknowledged — policy back to defaults", this.st.policy);
    this.save(); this.emitState();
    // 빈 장부를 협의회가 곧바로 다시 채운다 — 다음 제안이 올 때까지 현금으로 기다릴 이유가 없다
    void this.arbitrate("ledger reset").catch((e) => logger.warn("[control] re-arbitrate after reset failed", { error: (e as Error).message }));
  }

  /** 지속 정지 — 상태 파일에 남는다. 재배포해도 멈춰 있고, resume 전까지 어떤 결정도 집행되지 않는다 */
  pause(by = "operator") { this.st.paused = true; this.st.pausedAt = new Date().toISOString(); this.st.pausedBy = by; logger.warn("[control] PAUSED", { by }); this.save(); this.emitState(); }
  resume() { this.st.paused = false; this.st.pausedAt = null; this.st.pausedBy = null; logger.info("[control] resumed"); this.save(); this.emitState(); void this.arbitrate("resumed").catch(() => undefined); }

  private lastTickAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** 스케줄러 — 사람 없이 돌아가게 하는 부분. 주기마다: 만료 제안 정리 → 보류 결정이 집행 가능해졌으면 새 제안들로 재중재해 집행 */
  async tick(): Promise<void> {
    this.lastTickAt = new Date().toISOString();
    const before = this.st.proposals.length; this.activeProposals();
    if (this.st.proposals.length !== before) { logger.info("[control] expired proposals dropped", { dropped: before - this.st.proposals.length }); this.save(); }
    if (this.st.pending && Date.parse(this.st.pending.ts) < Date.now() - this.st.policy.proposalTtlH * 3600_000) {
      const d = this.st.pending; d.status = "skipped"; d.rationale.push("pending decision expired with its proposals"); this.st.pending = null; this.push(d); this.save(); this.emitState();
    }
    if (!this.st.autopilot || this.st.paused || riskManager.killSwitchActive) return;
    const sinceLast = this.st.lastExecutedAt ? (Date.now() - Date.parse(this.st.lastExecutedAt)) / 60_000 : Infinity;
    if (this.st.pending && sinceLast >= this.st.policy.minIntervalMin) {
      logger.info("[control] scheduler — pending decision eligible, re-arbitrating with current proposals");
      await this.arbitrate("scheduler");
      this.save(); this.emitState();
    }
  }
  startScheduler() {
    if (this.timer) return;
    const every = Math.max(1, config.CONTROL_TICK_MIN) * 60_000;
    this.timer = setInterval(() => void this.tick().catch((e) => logger.warn("[control] tick failed", { error: (e as Error).message })), every);
    this.timer.unref();
    setTimeout(() => void this.tick().catch(() => undefined), 90_000).unref();
    logger.info("[control] scheduler on", { everyMin: config.CONTROL_TICK_MIN, autopilot: this.st.autopilot, paused: this.st.paused });
  }

  setAutopilot(on: boolean) { this.st.autopilot = on; logger.info("[control] autopilot", { on }); this.save(); this.emitState(); if (on && this.st.pending) void this.arbitrate("autopilot on"); }
  setEngine(id: EngineId, patch: { enabled?: boolean; weight?: number }) {
    const e = this.st.engines[id]; if (!e) throw new Error("unknown engine");
    if (patch.enabled !== undefined) e.enabled = patch.enabled;
    if (patch.weight !== undefined) e.weight = Math.max(0.05, Math.min(5, patch.weight));
    this.save(); this.emitState();
  }
  setPolicy(patch: Partial<State["policy"]>) { this.st.policy = { ...this.st.policy, ...patch }; this.save(); this.emitState(); }

  markDay(date: string, dayReturnOf: (targets: Target[]) => number | null) {
    if (this.st.lastMarkedDate === date) return;
    const rets: Array<[EngineId, number]> = [];
    for (const e of ENGINES) {
      const s = this.st.engines[e.id];
      if (!s.lastProposal) continue;
      const r = dayReturnOf(s.lastProposal.targets);
      if (r === null) continue;
      s.returns.push(r); if (s.returns.length > 400) s.returns.shift();
      s.cumReturnPct = (s.returns.reduce((a, x) => a * (1 + x), 1) - 1) * 100;
      rets.push([e.id, r]);
    }
    if (rets.length) {
      const next = rets.map(([id, r]) => [id, this.st.engines[id].weight * Math.exp(this.st.policy.eta * r)] as const);
      const norm = next.reduce((a, [, w]) => a + w, 0) / next.length || 1;
      for (const [id, w] of next) this.st.engines[id].weight = w / norm;
      logger.info("[control] engine weights updated", Object.fromEntries(next.map(([id]) => [id, +this.st.engines[id].weight.toFixed(3)])));
    }
    this.st.lastMarkedDate = date;
    this.save(); this.emitState();
  }
}

export const controlPlane = new ControlPlane();
