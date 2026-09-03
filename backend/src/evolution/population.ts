import type { BtCandle } from "../crypto/backtest.js";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { controlPlane } from "../control/plane.js";
import { scannerServer } from "../crypto/scanner-server.js";
import { handsel } from "../office/handsel-client.js";
import { buildFeatures, dayReturn, evaluate, type FeatureSet, pickExamWindow } from "./evaluate.js";
import { mutateVectors, nextGeneration } from "./ga.js";
import { ARCHETYPES, GENE_SPECS, archetypeOf, clampGene, geneDistance, rand, randomVector, reseed, toGenes, upgradeVector, type GeneVector, type Genes } from "./genome.js";
import { DESKS, OFFICE_RENT_PCT, applySkills, consultDesks, latestOfficeDecision, rentFor, resetDeskCache, type DeskId, type DeskReading } from "./capabilities.js";

/**
 * 에이전트 개체군 — 서로 투자하고, 성과를 낸 개체는 복제되고, 실패한 개체는 죽는다.
 *
 * 개체 = 유전자(전략) + 페이퍼 자본. 매 세대:
 *   1. 시험: 모든 생존 개체가 같은 시험지(훈련 구간 밖 실캔들 60일)를 본다 → 적합도
 *   2. 자본 마킹: 새 일봉이 생겼으면 각자의 실제 타깃 비중으로 하루 수익을 자본에 반영.
 *      동료 위탁(peerAlloc)은 적합도 상위 동료들의 그날 수익을 그 비율만큼 가져온다 —
 *      자본이 잘하는 개체로 흘러가는 "서로 투자"의 실체
 *   3. 죽음: 자본 < 시드의 60%(굶주림) 또는 3세대 연속 하위 20%(도태). 최소 나이 3세대.
 *      죽은 개체의 자본은 금고(vault)로 돌아간다. 기록은 남는다
 *   4. 변이: 살아 있는 개체가 확률적으로 유전자 1~2개를 바꾼다 (PyGAD random_mutation).
 *      개체군 다양성(평균 유전 거리)이 낮아질수록 변이율이 올라간다 — 수렴 방지
 *   5. 병합: 유전적으로 거의 같은 두 개체(거리 < 0.06)는 하나로 합친다(자본 합산, 유전자
 *      자본가중 혼합). 동료에게 자본 25%+를 위탁하면서 그 동료보다 한참 못한 개체는 그
 *      동료에 흡수된다 — 자본이 잘하는 쪽으로 실제로 통합된다
 *   6. 분기: 상위 개체가 두 계통으로 갈라진다 — 자본 반씩, 한 유전자를 서로 반대 방향으로
 *      밀어 서로 다른 탐색 방향(tribe)을 만든다. 부모는 분기로 소멸, 두 가지가 계통을 잇는다
 *   7. 출생: 상위 개체를 부모로 PyGAD 교차·변이 → 자식. 시드는 부모 자본의 30% (부모가
 *      실제로 나눠 준다). 인구 상한까지
 * 전부 페이퍼이고 전부 실데이터(Upbit 일봉)다. 숫자를 지어내는 곳이 없다. 병합·분기는
 * PyGAD에 없는 개체군 수준 연산이라 여기서 직접 한다 (docs/evolution.md).
 */

export interface Agent {
  id: string;
  name: string;
  archetype: string;
  genes: Genes;
  vector: GeneVector;
  generationBorn: number;
  bornAt: string;
  parents: string[];
  alive: boolean;
  diedAt: string | null;
  causeOfDeath: string | null;
  capitalKrw: number;
  seedKrw: number;
  peakKrw: number;
  exam: { fitness: number; sharpe: number; totalReturnPct: number; maxDrawdownPct: number; rebalances: number; avgExposure: number; window?: { from: string; to: string } } | null;
  /** 세대별 적합도 — 세대마다 시험 창이 다르므로 절대값 비교가 아니라 "그 창을 본 개체들 사이의 순위"로 읽는다 */
  fitnessHistory: Array<{ gen: number; fitness: number; window?: { from: string; to: string } }>;
  capitalHistory: Array<{ date: string; capitalKrw: number }>;
  lastWeights: Array<{ market: string; weightPct: number }>;
  peers: string[];
  bottomStreak: number;
  children: number;
  /** 계통(tribe) — 창세 개체 id 또는 분기로 생긴 가지 id. 구름에서 군집/색의 기준 */
  tribe: string;
  /** 생애 사건: 변이·병합·분기·출생 (세대, 종류, 설명) */
  events: Array<{ gen: number; type: "born" | "mutated" | "merged" | "absorbed" | "forked" | "retired" | "tooled"; detail: string }>;
  forked: boolean;
  /** 이 개체의 오피스 — 이번 세대에 빌린 데스크, 읽은 것, 스킬이 타깃을 어떻게 바꿨는지, 낸 임대료 */
  office: {
    at: string;
    desks: DeskId[];
    usesOffice: boolean;
    readings: DeskReading[];
    notes: string[];
    baseWeights: Array<{ market: string; weightPct: number }>;
    rentKrw: number;
    rentPct: number;
  } | null;
  /** 누적 임대료 — 이 개체가 도구에 쓴 돈 전부 */
  rentPaidKrw: number;
}

export interface GenerationRecord {
  gen: number;
  at: string;
  examWindow: { from: string; to: string };
  alive: number;
  births: number;
  deaths: number;
  mutations: number;
  merges: number;
  forks: number;
  diversity: number;
  topFitness: number;
  meanFitness: number;
  championId: string | null;
  engine: string;
  vaultKrw: number;
  totalCapitalKrw: number;
}

export interface EvoLog {
  ts: string;
  level: "info" | "ok" | "warn" | "error";
  message: string;
}

interface State {
  generation: number;
  /** 직전 세대 시험 창의 시작 인덱스 — 다음 세대가 같은 창을 다시 뽑지 않도록 */
  lastExamStart?: number | null;
  agents: Agent[];
  history: GenerationRecord[];
  log: EvoLog[];
  vaultKrw: number;
  lastMarkedDate: string | null;
  lastGenerationAt: string | null;
  seedCounter: number;
}

const ROOT = join(process.cwd(), "data", "evolution");
const STATE_FILE = join(ROOT, "state.json");
const GEN_FILE = join(ROOT, "generations.jsonl");
const POP_MAX = 24;
const POP_MIN = 12;
const SEED_KRW = 1_000_000;
const STARVE_RATIO = 0.6;
const BOTTOM_QUANTILE = 0.2;
const BOTTOM_STREAK_DEATH = 3;
const MIN_AGE_GENS = 3;
const CHILD_SHARE = 0.3;
const EXAM_DAYS = 60;
const MUTATION_BASE = 0.1; // 개체당 세대별 자발 변이 확률
const DIVERSITY_FLOOR = 0.18; // 평균 유전 거리가 이 아래면 변이율 상승
const MERGE_DISTANCE = 0.06; // 이보다 가까우면 사실상 같은 전략 → 병합
const MERGE_DEPENDENCE = 0.25; // 위탁 비율이 이 이상이고 동료보다 한참 못하면 흡수
const MAX_MERGES = 2;
const MAX_FORKS = 1;
const LOG_MAX = 300;

const NAMES = ["ATLAS", "BORA", "CIEL", "DUNE", "EMBER", "FLINT", "GALE", "HALO", "IRIS", "JUNO", "KITE", "LUMEN", "MIRA", "NOVA", "ORION", "PIKE", "QUILL", "RIVER", "SOL", "TERRA", "UMBRA", "VEGA", "WREN", "XENO", "YARROW", "ZEPHYR"];

function readState(): State {
  try {
    if (existsSync(STATE_FILE)) {
      const st = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State;
      for (const a of st.agents) {
        a.tribe ??= a.parents[0] ? (st.agents.find((p) => p.id === a.parents[0])?.tribe ?? a.id) : a.id; a.events ??= [{ gen: a.generationBorn, type: "born", detail: a.parents.length ? `child of ${a.parents.join(",")}` : "genesis" }]; a.forked ??= false;
        a.office ??= null; a.rentPaidKrw ??= 0;
        // 구버전 10유전자 개체 — 데스크 유전자 0(눈 없음)으로 확장. 도구는 진화가 스스로 켠다
        if (a.vector.length !== GENE_SPECS.length) { a.vector = upgradeVector(a.vector); a.genes = toGenes(a.vector); a.archetype = archetypeOf(a.genes); }
      }
      return st;
    }
  } catch (e) {
    logger.warn("진화 상태 복원 실패 — 새로 시작", { error: (e as Error).message });
  }
  return { generation: 0, agents: [], history: [], log: [], vaultKrw: 0, lastMarkedDate: null, lastGenerationAt: null, seedCounter: 0 };
}

class Evolution extends EventEmitter {
  private st: State = readState();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private features: FeatureSet | null = null;

  private save() {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.st));
    renameSync(tmp, STATE_FILE);
  }

  private log(level: EvoLog["level"], message: string) {
    const line = { ts: new Date().toISOString(), level, message };
    this.st.log.unshift(line);
    if (this.st.log.length > LOG_MAX) this.st.log.length = LOG_MAX;
    logger.info(`[evolution] ${message}`);
    this.emit("log", line);
  }

  status() {
    const alive = this.st.agents.filter((a) => a.alive);
    const champion = alive.slice().sort((a, b) => (b.exam?.fitness ?? -9) - (a.exam?.fitness ?? -9))[0] ?? null;
    return {
      enabled: config.EVOLUTION,
      intervalHours: config.EVOLUTION_INTERVAL_H,
      generation: this.st.generation,
      running: this.running,
      lastGenerationAt: this.st.lastGenerationAt,
      lastMarkedDate: this.st.lastMarkedDate,
      alive: alive.length,
      total: this.st.agents.length,
      popMax: POP_MAX,
      vaultKrw: Math.round(this.st.vaultKrw),
      totalCapitalKrw: Math.round(alive.reduce((a, x) => a + x.capitalKrw, 0)),
      seedKrw: SEED_KRW,
      examDays: EXAM_DAYS,
      champion: champion ? { id: champion.id, name: champion.name, archetype: champion.archetype, fitness: champion.exam?.fitness ?? null } : null,
      diversity: this.diversity(alive),
      tribes: [...new Set(alive.map((a) => a.tribe))].map((t) => ({ tribe: t, name: this.st.agents.find((a) => a.id === t)?.name ?? t, alive: alive.filter((a) => a.tribe === t).length, capitalKrw: Math.round(alive.filter((a) => a.tribe === t).reduce((s, a) => s + a.capitalKrw, 0)) })),
      archetypes: ARCHETYPES.map((k) => ({ archetype: k, alive: alive.filter((a) => a.archetype === k).length })),
      genes: GENE_SPECS,
      desks: DESKS.map((d) => ({ id: d.id, label: d.label, labelKo: d.labelKo, tool: d.tool, server: d.server === "worker" ? config.OFFICE_WORKER_URL : d.server, rentPct: d.rentPct, skill: d.skill, tenants: alive.filter((a) => a.genes[d.id] >= 1).length })),
      officeRentPct: OFFICE_RENT_PCT,
      rentPaidKrw: Math.round(this.st.agents.reduce((a, x) => a + (x.rentPaidKrw ?? 0), 0)),
      rules: { starveRatio: STARVE_RATIO, bottomQuantile: BOTTOM_QUANTILE, bottomStreakDeath: BOTTOM_STREAK_DEATH, minAgeGens: MIN_AGE_GENS, childShare: CHILD_SHARE, mutationBase: MUTATION_BASE, diversityFloor: DIVERSITY_FLOOR, mergeDistance: MERGE_DISTANCE, mergeDependence: MERGE_DEPENDENCE },
    };
  }
  agents() { return this.st.agents; }
  agent(id: string) { return this.st.agents.find((a) => a.id === id) ?? null; }
  history() { return this.st.history; }
  logs(limit = 100) { return this.st.log.slice(0, limit); }

  squad() {
    const alive = this.st.agents.filter((a) => a.alive && a.exam).sort((a, b) => b.exam!.fitness - a.exam!.fitness).slice(0, 3);
    const wsum = alive.reduce((a, x) => a + Math.max(0.01, x.exam!.fitness + 3), 0);
    const targets = new Map<string, number>();
    for (const a of alive) {
      const w = Math.max(0.01, a.exam!.fitness + 3) / wsum;
      for (const t of a.lastWeights) targets.set(t.market, (targets.get(t.market) ?? 0) + w * t.weightPct);
    }
    return { members: alive.map((a) => ({ id: a.id, name: a.name, archetype: a.archetype, fitness: a.exam!.fitness, capitalKrw: Math.round(a.capitalKrw), lastWeights: a.lastWeights })), targets: [...targets].map(([market, weightPct]) => ({ market, weightPct: +weightPct.toFixed(2) })).filter((t) => t.weightPct >= 1) };
  }

  async deploySquad(reason = "evolution squad") {
    const sq = this.squad();
    if (sq.targets.length === 0) throw new Error("스쿼드 타깃 없음 — 아직 시험을 본 개체가 없다");
    // 장부 직접 회전 대신 제어 평면 제안 — 확신도 = 스쿼드 평균 적합도를 0~1로 (fitness 0 → 0.25, 3 → 1)
    const avgFit = sq.members.reduce((a, m) => a + m.fitness, 0) / Math.max(1, sq.members.length);
    const { decision } = await controlPlane.propose({
      engine: "evolution",
      targets: sq.targets,
      confidence: Math.max(0, Math.min(1, 0.25 + avgFit / 4)),
      evidence: `${reason} · squad ${sq.members.map((m) => `${m.name}(${m.fitness.toFixed(2)})`).join("/")} · exam ${EXAM_DAYS}d unseen (window ${this.st.history[this.st.history.length - 1]?.examWindow.from ?? "?"}~${this.st.history[this.st.history.length - 1]?.examWindow.to ?? "?"})`,
      ref: `gen ${this.st.generation}`,
    });
    const r = decision?.execution ?? { orders: 0, skipped: [] as string[], error: decision ? `control plane: ${decision.status}` : "no decision" };
    this.log(decision?.status === "executed" ? "ok" : "info", decision?.status === "executed" ? `DEPLOY squad ${sq.members.map((m) => m.name).join("/")} → paper ledger via control plane: ${r.orders} orders` : `PROPOSED squad ${sq.members.map((m) => m.name).join("/")} → control plane: ${decision?.status ?? "no decision"}`);
    this.save();
    return { squad: sq, result: r, decision };
  }

  private newAgent(vector: GeneVector, gen: number, parents: string[], seedKrw: number, tribe?: string, nameOverride?: string): Agent {
    const genes = toGenes(vector);
    const n = this.st.seedCounter++;
    const name = nameOverride ?? `${NAMES[n % NAMES.length]}-${String(Math.floor(n / NAMES.length) + 1).padStart(2, "0")}`;
    const id = `ag_${gen}_${n.toString(36)}`;
    return {
      id, name, archetype: archetypeOf(genes), genes, vector, generationBorn: gen, bornAt: new Date().toISOString(), parents,
      alive: true, diedAt: null, causeOfDeath: null, capitalKrw: seedKrw, seedKrw, peakKrw: seedKrw, exam: null, fitnessHistory: [], capitalHistory: [], lastWeights: [], peers: [], bottomStreak: 0, children: 0,
      tribe: tribe ?? id, events: [{ gen, type: "born", detail: parents.length ? `child of ${parents.join(",")}` : "genesis" }], forked: false, office: null, rentPaidKrw: 0,
    };
  }

  /** 개체군 다양성 — 생존 개체 간 평균 유전 거리 (0 = 전부 같은 전략) */
  private diversity(agents: Agent[]): number {
    if (agents.length < 2) return 1;
    let s = 0, n = 0;
    for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) { s += geneDistance(agents[i].vector, agents[j].vector); n++; }
    return +(s / n).toFixed(4);
  }

  private reGenome(a: Agent, vector: GeneVector) {
    a.vector = vector; a.genes = toGenes(vector);
    const arch = archetypeOf(a.genes);
    if (arch !== a.archetype) a.archetype = arch;
  }

  private series: Map<string, BtCandle[]> | null = null;
  private async loadFeatures(): Promise<FeatureSet> {
    const { series } = await scannerServer.series();
    this.series = series;
    this.features = buildFeatures(series, EXAM_DAYS);
    return this.features;
  }

  async step(reason = "scheduled"): Promise<GenerationRecord> {
    if (this.running) throw new Error("진화 세대가 이미 진행 중");
    this.running = true;
    try {
      const f = await this.loadFeatures();
      const gen = ++this.st.generation;
      reseed(20260902 + gen);
      // 시험지: 세대마다 다른 60일 창. HMM은 그 창 앞까지만 적합(창 안에 미래 정보 없음). f(최신 창)는 실전 배치 타깃·자본 마킹용
      const win = pickExamWindow({ datesLen: f.dates.length, examDays: EXAM_DAYS, rand, prevStart: this.st.lastExamStart ?? null });
      const fExam = buildFeatures(this.series!, EXAM_DAYS, win.start);
      const examRange = { from: fExam.trainEnd, to: Math.min(fExam.trainEnd + EXAM_DAYS, fExam.dates.length - 1) };
      const examFrom = fExam.dates[examRange.from], examTo = fExam.dates[examRange.to];
      this.st.lastExamStart = win.start;
      this.log("info", `GEN ${gen} — ${reason} · exam ${examFrom}~${examTo} (${examRange.to - examRange.from} unseen days, window start day ${win.start} of ${win.choices} possible starts, HMM fit before ${examFrom}) · ${fExam.markets.length} markets · live targets from ${f.dates[f.trainEnd]}~${f.dates[f.dates.length - 1]}`);

      if (this.st.agents.filter((a) => a.alive).length === 0) {
        for (let i = 0; i < POP_MIN; i++) this.st.agents.push(this.newAgent(randomVector(), gen, [], SEED_KRW));
        this.log("info", `genesis — ${POP_MIN} random genomes seeded ₩${SEED_KRW.toLocaleString()} each`);
      }
      const alive = () => this.st.agents.filter((a) => a.alive);

      for (const a of alive()) {
        const r = evaluate(a.genes, fExam, examRange); // 적합도: 이번 세대의 시험 창
        const live = evaluate(a.genes, f); // 실전 타깃: 최신 데이터의 마지막 리밸런스 (시험 창의 과거 타깃을 배치하면 안 된다)
        a.exam = { fitness: r.fitness, sharpe: r.sharpe, totalReturnPct: r.totalReturnPct, maxDrawdownPct: r.maxDrawdownPct, rebalances: r.rebalances, avgExposure: r.avgExposure, window: { from: examFrom, to: examTo } };
        a.fitnessHistory.push({ gen, fitness: r.fitness, window: { from: examFrom, to: examTo } });
        if (a.fitnessHistory.length > 200) a.fitnessHistory.shift();
        a.lastWeights = live.lastWeights;
      }

      // 1b) 오피스 — 데스크를 켠 개체는 실제 MCP 보고서를 읽고 스킬로 라이브 타깃을 고친다. 임대료는 자본에서.
      //     시험(exam)은 그대로 숫자 전략의 성적이고, 자본 마킹은 도구를 거친 타깃으로 된다 — 도구값을 못 하면 굶는다.
      {
        resetDeskCache(gen);
        const universe = f.markets.map((m) => m.market.replace("KRW-", ""));
        const officeDecision = latestOfficeDecision();
        const tenants = alive().filter((a) => rentFor(a.genes, a.capitalKrw, false).desks.length > 0 || (officeDecision && a.genes.toolTrust >= 0.5 && a.genes.deskChart >= 1 && a.genes.deskRisk >= 1));
        const t0 = Date.now();
        let rentTotal = 0, consulted = 0, failed = 0;
        for (const a of alive()) a.office = null;
        await Promise.all(tenants.map(async (a) => {
          const usesOffice = Boolean(officeDecision) && a.genes.toolTrust >= 0.5 && a.genes.deskChart >= 1 && a.genes.deskRisk >= 1;
          const base = a.lastWeights.map((w) => ({ ...w }));
          const session = await consultDesks(a.genes, base, universe);
          if (usesOffice && officeDecision) { session.input.office = officeDecision.targets; session.readings.push({ desk: "office", ok: true, summary: `committee ${officeDecision.delegationId} (${officeDecision.decidedAt.slice(0, 10)}): ${officeDecision.targets.map((t) => `${t.market.replace("KRW-", "")} ${t.weightPct}%`).join(" ")}`, ms: 0 }); }
          const ov = applySkills(base, a.genes.toolTrust, session.input);
          const rent = rentFor(a.genes, a.capitalKrw, usesOffice);
          a.capitalKrw = Math.max(0, a.capitalKrw - rent.krw); a.rentPaidKrw = (a.rentPaidKrw ?? 0) + rent.krw; rentTotal += rent.krw;
          a.lastWeights = ov.targets;
          a.office = { at: new Date().toISOString(), desks: rent.desks, usesOffice, readings: session.readings, notes: ov.notes, baseWeights: base, rentKrw: rent.krw, rentPct: rent.pct };
          consulted++; failed += session.readings.filter((r) => !r.ok).length;
          const changed = JSON.stringify(base) !== JSON.stringify(ov.targets);
          if (changed || session.readings.some((r) => !r.ok)) a.events.push({ gen, type: "tooled", detail: `${rent.desks.map((d) => d.replace("desk", "").toLowerCase()).join("+")}${usesOffice ? "+office" : ""} · rent ₩${rent.krw.toLocaleString()} · ${ov.notes.length ? ov.notes.join(" | ") : "no change"}${session.readings.filter((r) => !r.ok).length ? ` · failed: ${session.readings.filter((r) => !r.ok).map((r) => r.desk).join(",")}` : ""}` });
          if (a.events.length > 60) a.events.splice(1, a.events.length - 60);
        }));
        if (tenants.length) this.log("info", `OFFICES — ${consulted} agents consulted real desks (${[...new Set(tenants.flatMap((a) => rentFor(a.genes, 0, false).desks))].map((d) => d.replace("desk", "").toLowerCase()).join(",")}${officeDecision ? ", committee decision available" : ""}) in ${((Date.now() - t0) / 1000).toFixed(1)}s · rent ₩${rentTotal.toLocaleString()} · ${failed} desk reads failed`);
        else this.log("info", "OFFICES — no agent rents a desk this generation (all desk genes off)");
      }
      const ranked = alive().sort((a, b) => b.exam!.fitness - a.exam!.fitness);

      for (const a of ranked) a.peers = ranked.filter((p) => p.id !== a.id).slice(0, a.genes.peerTopN).map((p) => p.id);
      const lastDay = f.dates.length - 2;
      const markDate = f.dates[lastDay + 1];
      if (markDate && markDate !== this.st.lastMarkedDate) {
        const own = new Map<string, number>();
        for (const a of ranked) own.set(a.id, dayReturn(a.lastWeights, f, lastDay) ?? 0);
        for (const a of ranked) {
          const peerRet = a.peers.length ? a.peers.reduce((s, id) => s + (own.get(id) ?? 0), 0) / a.peers.length : 0;
          const r = (1 - a.genes.peerAlloc) * (own.get(a.id) ?? 0) + a.genes.peerAlloc * peerRet;
          a.capitalKrw *= 1 + r;
          a.peakKrw = Math.max(a.peakKrw, a.capitalKrw);
          a.capitalHistory.push({ date: markDate, capitalKrw: Math.round(a.capitalKrw) });
          if (a.capitalHistory.length > 400) a.capitalHistory.shift();
        }
        this.st.lastMarkedDate = markDate;
        this.log("info", `capital marked for ${markDate} — own return applied, peer allocations settled`);
      }

      let deaths = 0;
      const cut = Math.floor(ranked.length * BOTTOM_QUANTILE);
      ranked.forEach((a, i) => { a.bottomStreak = i >= ranked.length - cut && ranked.length > 4 ? a.bottomStreak + 1 : 0; });
      for (const a of ranked) {
        const age = gen - a.generationBorn;
        let cause: string | null = null;
        if (a.capitalKrw < a.seedKrw * STARVE_RATIO && age >= 1) cause = `starved — capital ₩${Math.round(a.capitalKrw).toLocaleString()} < ${STARVE_RATIO * 100}% of seed`;
        else if (a.bottomStreak >= BOTTOM_STREAK_DEATH && age >= MIN_AGE_GENS) cause = `outcompeted — bottom ${BOTTOM_QUANTILE * 100}% for ${a.bottomStreak} generations (fitness ${a.exam!.fitness})`;
        if (cause && alive().length > POP_MIN / 2) {
          a.alive = false; a.diedAt = new Date().toISOString(); a.causeOfDeath = cause; a.events.push({ gen, type: "retired", detail: cause });
          this.st.vaultKrw += a.capitalKrw; a.capitalKrw = 0; deaths++;
          this.log("warn", `RETIRED ${a.name} [${a.archetype}] — ${cause}`);
        }
      }

      // 4) 변이 — 살아 있는 개체의 자발적 변이 (다양성이 낮으면 변이율 상승)
      let mutations = 0;
      const div = this.diversity(alive());
      const mutRate = MUTATION_BASE + (div < DIVERSITY_FLOOR ? (DIVERSITY_FLOOR - div) / DIVERSITY_FLOOR * 0.25 : 0);
      const mutants = alive().filter((a) => gen - a.generationBorn >= 1 && rand() < mutRate);
      if (mutants.length) {
        const m = await mutateVectors(mutants.map((a) => a.vector), rand() < 0.5 ? 1 : 2, gen * 7 + 1);
        mutants.forEach((a, i) => {
          const before = a.vector, after = m.mutated[i];
          const changed = GENE_SPECS.map((g, k) => (before[k] !== after[k] ? `${g.key} ${before[k]}→${after[k]}` : null)).filter(Boolean);
          if (changed.length === 0) return;
          const archBefore = a.archetype;
          this.reGenome(a, after);
          a.events.push({ gen, type: "mutated", detail: changed.join(", ") });
          mutations++;
          this.log("info", `MUTATED ${a.name} — ${changed.join(", ")}${archBefore !== a.archetype ? ` · ${archBefore} → ${a.archetype}` : ""} (${m.engine}${m.version ? "@" + m.version : ""}, rate ${(mutRate * 100).toFixed(0)}%, diversity ${div})`);
        });
      }

      // 5) 병합 — 거의 같은 전략끼리, 또는 위탁 종속 개체가 그 동료에 흡수
      let merges = 0;
      const mergeInto = (weak: Agent, strong: Agent, why: string) => {
        const total = weak.capitalKrw + strong.capitalKrw;
        const wS = total > 0 ? strong.capitalKrw / total : 0.5;
        const blended = GENE_SPECS.map((g, k) => clampGene(g, strong.vector[k] * wS + weak.vector[k] * (1 - wS)));
        this.reGenome(strong, blended);
        strong.capitalKrw = total; strong.peakKrw = Math.max(strong.peakKrw, total); strong.seedKrw += weak.seedKrw;
        strong.events.push({ gen, type: "merged", detail: `absorbed ${weak.name} (+₩${Math.round(weak.capitalKrw).toLocaleString()}) — ${why}` });
        weak.alive = false; weak.diedAt = new Date().toISOString(); weak.causeOfDeath = `merged into ${strong.name} — ${why}`;
        weak.events.push({ gen, type: "absorbed", detail: `into ${strong.name} — ${why}` });
        weak.capitalKrw = 0; merges++;
        this.log("warn", `MERGED ${weak.name} → ${strong.name} — ${why} · capital now ₩${Math.round(total).toLocaleString()}, genome blended ${(wS * 100).toFixed(0)}/${(100 - wS * 100).toFixed(0)}`);
      };
      {
        const pool = alive().sort((a, b) => b.exam!.fitness - a.exam!.fitness);
        // (a) 근접 복제체
        for (let i = 0; i < pool.length && merges < MAX_MERGES; i++) {
          for (let j = i + 1; j < pool.length && merges < MAX_MERGES; j++) {
            const a = pool[i], b = pool[j];
            if (!a.alive || !b.alive) continue;
            const d = geneDistance(a.vector, b.vector);
            if (d < MERGE_DISTANCE) mergeInto(b, a, `genomes nearly identical (distance ${d.toFixed(3)})`);
          }
        }
        // (b) 위탁 종속 — 동료에 25%+ 위탁하고 그 동료보다 fitness 1.0 이상 못하면 흡수
        for (const a of pool) {
          if (merges >= MAX_MERGES || !a.alive) break;
          if (a.genes.peerAlloc < MERGE_DEPENDENCE || gen - a.generationBorn < 2) continue;
          const top = a.peers.map((id) => this.st.agents.find((x) => x.id === id)).find((p) => p?.alive);
          if (top && top.exam && a.exam && top.exam.fitness - a.exam.fitness >= 1.0) mergeInto(a, top, `delegates ${(a.genes.peerAlloc * 100).toFixed(0)}% to a peer ${(top.exam.fitness - a.exam.fitness).toFixed(2)} fitter`);
        }
      }

      // 6) 분기 — 상위 개체가 두 계통으로 갈라진다 (자본 반씩, 한 유전자를 반대로 밀기)
      let forks = 0;
      {
        const elite = alive().sort((a, b) => b.exam!.fitness - a.exam!.fitness).slice(0, Math.max(1, Math.ceil(alive().length * 0.2)));
        // 자본 바닥(시드의 절반)이 안 되는 개체는 분기하지 않는다 — 먼지 가지 방지
        const cand = elite.find((a) => !a.forked && gen - a.generationBorn >= 2 && a.capitalKrw >= a.seedKrw * 0.8 && a.capitalKrw >= SEED_KRW * 0.5 && alive().length + 1 <= POP_MAX);
        if (cand && forks < MAX_FORKS) {
          const k = Math.floor(rand() * GENE_SPECS.length);
          const g = GENE_SPECS[k];
          const push = (g.max - g.min) * 0.25;
          const vA = cand.vector.map((v, i) => (i === k ? clampGene(g, v - push) : v));
          const vB = cand.vector.map((v, i) => (i === k ? clampGene(g, v + push) : v));
          const half = cand.capitalKrw / 2;
          const a = this.newAgent(vA, gen, [cand.id], half, `${cand.id}/A`, `${cand.name}/A`);
          const b = this.newAgent(vB, gen, [cand.id], half, `${cand.id}/B`, `${cand.name}/B`);
          a.events.push({ gen, type: "forked", detail: `branch A of ${cand.name}: ${g.key} ${cand.vector[k]}→${vA[k]}` });
          b.events.push({ gen, type: "forked", detail: `branch B of ${cand.name}: ${g.key} ${cand.vector[k]}→${vB[k]}` });
          cand.forked = true; cand.alive = false; cand.diedAt = new Date().toISOString(); cand.causeOfDeath = `forked into ${a.name} / ${b.name}`;
          cand.events.push({ gen, type: "forked", detail: `split on ${g.key}: ${vA[k]} | ${vB[k]} — capital ₩${Math.round(half).toLocaleString()} each` });
          cand.capitalKrw = 0; cand.children += 2;
          this.st.agents.push(a, b); forks++;
          this.log("ok", `FORKED ${cand.name} → ${a.name} (${g.key}=${vA[k]}) | ${b.name} (${g.key}=${vB[k]}) — two tribes, ₩${Math.round(half).toLocaleString()} each`);
        }
      }

      let births = 0;
      let engine = "none";
      const survivors = alive().sort((a, b) => (b.exam?.fitness ?? -9) - (a.exam?.fitness ?? -9));
      const slots = POP_MAX - survivors.length;
      const wanted = Math.min(slots, Math.max(2, Math.ceil(survivors.length * 0.2)));
      if (wanted > 0 && survivors.length >= 2) {
        const ga = await nextGeneration(survivors.map((a) => a.vector), survivors.map((a) => a.exam?.fitness ?? -1), wanted, gen);
        engine = ga.engine + (ga.version ? `@${ga.version}` : "");
        for (const child of ga.children) {
          const parent = survivors.filter((p) => p.capitalKrw >= p.seedKrw * 0.9 && p.capitalKrw >= SEED_KRW * 0.5).sort((p, q) => geneDistance(p.vector, child) - geneDistance(q.vector, child))[0];
          if (!parent) { this.log("warn", "no parent has surplus over its seed — no births this generation"); break; }
          const seed = parent.capitalKrw * CHILD_SHARE;
          parent.capitalKrw -= seed; parent.children++;
          const kid = this.newAgent(child, gen, [parent.id], seed, parent.tribe);
          this.st.agents.push(kid); births++;
          this.log("ok", `BORN ${kid.name} [${kid.archetype}] ← ${parent.name} seeds ₩${Math.round(seed).toLocaleString()} (${engine}: ${Object.values(ga.ops).join("/")})`);
        }
      }

      const finalAlive = alive();
      const fits = finalAlive.map((a) => a.exam?.fitness).filter((x): x is number => typeof x === "number");
      const champion = ranked[0] ?? null;
      const rec: GenerationRecord = {
        gen, at: new Date().toISOString(), examWindow: { from: examFrom, to: examTo }, alive: finalAlive.length, births, deaths, mutations, merges, forks, diversity: this.diversity(finalAlive),
        topFitness: fits.length ? Math.max(...fits) : 0, meanFitness: fits.length ? +(fits.reduce((a, b) => a + b, 0) / fits.length).toFixed(4) : 0,
        championId: champion?.id ?? null, engine, vaultKrw: Math.round(this.st.vaultKrw), totalCapitalKrw: Math.round(finalAlive.reduce((a, x) => a + x.capitalKrw, 0)),
      };
      this.st.history.push(rec);
      if (this.st.history.length > 500) this.st.history.shift();
      this.st.lastGenerationAt = rec.at;
      mkdirSync(ROOT, { recursive: true });
      appendFileSync(GEN_FILE, JSON.stringify(rec) + "\n");
      if (config.EVOLUTION_PROPOSE && finalAlive.some((a) => a.exam)) void this.deploySquad(`gen ${gen}`).catch((e) => this.log("warn", `squad proposal failed — ${(e as Error).message}`));
      this.log("ok", `GEN ${gen} done — survivors ${rec.alive}/${POP_MAX} · births ${births} · deaths ${deaths} · mutations ${mutations} · merges ${merges} · forks ${forks} · diversity ${rec.diversity} · top ${rec.topFitness} (${champion?.name ?? "-"}) · mean ${rec.meanFitness} · engine ${engine}`);
      this.save();
      this.emit("generation", rec);
      return rec;
    } finally {
      this.running = false;
    }
  }

  async handselLineage(): Promise<{ configured: boolean; report: string | null; automaton: string | null }> {
    if (!handsel.configured()) return { configured: false, report: null, automaton: null };
    const [report, automaton] = await Promise.all([
      handsel.call("lineage_report", { office: config.OFFICE_SLOT }).catch((e: Error) => `error: ${e.message}`),
      handsel.call("set_office_automaton", { office: config.OFFICE_SLOT }).catch((e: Error) => `error: ${e.message}`),
    ]);
    return { configured: true, report, automaton };
  }

  startAutoLoop() {
    if (!config.EVOLUTION || this.timer) return;
    const period = config.EVOLUTION_INTERVAL_H * 60 * 60_000;
    const run = () => void this.step("scheduled").catch((e) => logger.warn("진화 세대 실패", { error: (e as Error).message }));
    setTimeout(run, 3 * 60_000).unref();
    this.timer = setInterval(run, period);
    this.timer.unref();
    logger.info("진화 루프 예약", { everyHours: config.EVOLUTION_INTERVAL_H, popMax: POP_MAX });
  }
}

export const evolution = new Evolution();
