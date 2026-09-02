import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { cryptoDesk } from "../crypto/desk.js";
import { upbit } from "../crypto/upbit.js";
import { riskManager } from "../risk/riskManager.js";

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
  engines: Record<EngineId, EngineState>;
  proposals: Proposal[];
  decisions: Decision[];
  pending: Decision | null;
  lastExecutedAt: string | null;
  lastMarkedDate: string | null;
  policy: { maxWeightPct: number; maxPositions: number; cashFloorPct: number; grossMaxPct: number; minTurnoverPct: number; minIntervalMin: number; proposalTtlH: number; eta: number };
}

const FILE = join(process.cwd(), "data", "control", "state.json");
const DEFAULT_POLICY: State["policy"] = { maxWeightPct: 30, maxPositions: 8, cashFloorPct: 10, grossMaxPct: 90, minTurnoverPct: 5, minIntervalMin: 30, proposalTtlH: 30, eta: 8 };

function fresh(): State {
  const engines = Object.fromEntries(ENGINES.map((e) => [e.id, { id: e.id, enabled: true, weight: 1, lastProposal: null, returns: [], cumReturnPct: 0, proposals: 0 }])) as unknown as Record<EngineId, EngineState>;
  return { autopilot: config.CONTROL_AUTOPILOT, engines, proposals: [], decisions: [], pending: null, lastExecutedAt: null, lastMarkedDate: null, policy: DEFAULT_POLICY };
}
function readState(): State {
  try {
    if (existsSync(FILE)) { const st = JSON.parse(readFileSync(FILE, "utf-8")) as State; st.policy = { ...DEFAULT_POLICY, ...st.policy }; const f = fresh(); for (const e of ENGINES) st.engines[e.id] ??= f.engines[e.id]; return st; }
  } catch (e) { logger.warn("제어 평면 상태 복원 실패 — 새로 시작", { error: (e as Error).message }); }
  return fresh();
}

class ControlPlane extends EventEmitter {
  private st = readState();
  private priceOf: () => Map<string, number> = () => new Map();
  attachPrices(fn: () => Map<string, number>) { this.priceOf = fn; }

  private save() { mkdirSync(dirname(FILE), { recursive: true }); const tmp = `${FILE}.tmp`; writeFileSync(tmp, JSON.stringify(this.st)); renameSync(tmp, FILE); }
  private emitState() { this.emit("state", this.status()); }

  status() {
    const desk = cryptoDesk.status();
    const holdings = desk.positions.map((p) => ({ market: `KRW-${p.symbol}`, weightPct: desk.equityKrw > 0 ? +(((p.qty * p.curKrw) / desk.equityKrw) * 100).toFixed(2) : 0 }));
    const wsum = ENGINES.filter((e) => this.st.engines[e.id].enabled).reduce((a, e) => a + this.st.engines[e.id].weight, 0) || 1;
    return {
      autopilot: this.st.autopilot,
      mode: desk.mode,
      killSwitch: riskManager.killSwitchActive,
      policy: this.st.policy,
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
    const rationale: string[] = [];
    const constraints: string[] = [];
    const contribs = props.map((p) => ({ engine: p.engine, weight: this.st.engines[p.engine].weight, confidence: p.confidence, proposalId: p.id, targets: p.targets, eff: this.st.engines[p.engine].weight * (0.25 + 0.75 * p.confidence) }));
    const effSum = contribs.reduce((a, c) => a + c.eff, 0) || 1;
    const blend = new Map<string, number>();
    const who = new Map<string, string[]>();
    for (const c of contribs) {
      const share = c.eff / effSum;
      rationale.push(`${c.engine}: share ${(share * 100).toFixed(0)}% (weight ${c.weight.toFixed(2)} × conf ${c.confidence.toFixed(2)}) · ${c.targets.map((t) => `${t.market.replace("KRW-", "")} ${t.weightPct}%`).join(", ") || "cash"}`);
      for (const t of c.targets) { blend.set(t.market, (blend.get(t.market) ?? 0) + share * t.weightPct); who.set(t.market, [...(who.get(t.market) ?? []), c.engine]); }
    }
    let targets = [...blend].map(([market, w]) => ({ market, weightPct: +w.toFixed(2) })).filter((t) => t.weightPct >= 0.5).sort((a, b) => b.weightPct - a.weightPct);
    for (const t of targets) if (t.weightPct > pol.maxWeightPct) { constraints.push(`${t.market} ${t.weightPct}% → cap ${pol.maxWeightPct}%`); t.weightPct = pol.maxWeightPct; }
    if (targets.length > pol.maxPositions) { constraints.push(`${targets.length} positions → max ${pol.maxPositions} (dropped ${targets.slice(pol.maxPositions).map((t) => t.market.replace("KRW-", "")).join(",")})`); targets = targets.slice(0, pol.maxPositions); }
    let gross = targets.reduce((a, t) => a + t.weightPct, 0);
    const grossMax = Math.min(pol.grossMaxPct, 100 - pol.cashFloorPct);
    if (gross > grossMax) { const k = grossMax / gross; constraints.push(`gross ${gross.toFixed(1)}% → ${grossMax}% (scaled ×${k.toFixed(2)})`); targets = targets.map((t) => ({ ...t, weightPct: +(t.weightPct * k).toFixed(2) })); gross = grossMax; }
    if (riskManager.killSwitchActive) constraints.push("KILL SWITCH active — decision blocked");
    const cur = new Map(this.status().holdings.map((h) => [h.market, h.weightPct]));
    let turnover = 0;
    for (const m of new Set([...cur.keys(), ...targets.map((t) => t.market)])) turnover += Math.abs((targets.find((t) => t.market === m)?.weightPct ?? 0) - (cur.get(m) ?? 0));
    turnover /= 2;
    const decision: Decision = {
      id: `dc_${Date.now().toString(36)}`, ts: new Date().toISOString(), status: "pending", targets, cashPct: +(100 - gross).toFixed(2),
      contributions: contribs.map(({ engine, weight, confidence, proposalId, targets: tg }) => ({ engine, weight: +weight.toFixed(4), confidence, proposalId, targets: tg })),
      rationale: [...rationale, ...[...who].map(([m, es]) => `${m.replace("KRW-", "")} ← ${[...new Set(es)].join("+")}`)], constraints, turnoverPct: +turnover.toFixed(2), execution: null, by: null,
    };
    if (riskManager.killSwitchActive) { decision.status = "blocked"; this.push(decision); logger.warn("[control] blocked by kill switch"); return decision; }
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
    if (!r.error) { this.st.lastExecutedAt = decision.execution.ts; this.st.proposals = []; }
    if (this.st.pending?.id === decision.id) this.st.pending = null;
    this.push(decision);
    logger.info("[control] executed", { by, orders: r.orders.length, error: r.error ?? null });
    this.save(); this.emitState();
    return decision;
  }

  approve(): Promise<Decision> { const d = this.st.pending; if (!d) throw new Error("승인 대기 결정 없음"); return this.execute(d, "operator", "approved"); }
  reject(): Decision { const d = this.st.pending; if (!d) throw new Error("승인 대기 결정 없음"); d.status = "rejected"; d.by = "operator"; this.st.pending = null; this.push(d); this.save(); this.emitState(); return d; }
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
