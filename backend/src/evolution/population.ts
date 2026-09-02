import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { cryptoDesk } from "../crypto/desk.js";
import { scannerServer } from "../crypto/scanner-server.js";
import { handsel } from "../office/handsel-client.js";
import { buildFeatures, dayReturn, evaluate, type FeatureSet } from "./evaluate.js";
import { nextGeneration } from "./ga.js";
import { ARCHETYPES, GENE_SPECS, archetypeOf, geneDistance, randomVector, reseed, toGenes, type GeneVector, type Genes } from "./genome.js";

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
 *   4. 출생: 상위 개체를 부모로 PyGAD 교차·변이 → 자식. 시드는 부모 자본의 30% (부모가
 *      실제로 나눠 준다). 인구 상한까지
 * 전부 페이퍼이고 전부 실데이터(Upbit 일봉)다. 숫자를 지어내는 곳이 없다.
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
  exam: { fitness: number; sharpe: number; totalReturnPct: number; maxDrawdownPct: number; rebalances: number; avgExposure: number } | null;
  fitnessHistory: Array<{ gen: number; fitness: number }>;
  capitalHistory: Array<{ date: string; capitalKrw: number }>;
  lastWeights: Array<{ market: string; weightPct: number }>;
  peers: string[];
  bottomStreak: number;
  children: number;
}

export interface GenerationRecord {
  gen: number;
  at: string;
  examWindow: { from: string; to: string };
  alive: number;
  births: number;
  deaths: number;
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
const LOG_MAX = 300;

const NAMES = ["ATLAS", "BORA", "CIEL", "DUNE", "EMBER", "FLINT", "GALE", "HALO", "IRIS", "JUNO", "KITE", "LUMEN", "MIRA", "NOVA", "ORION", "PIKE", "QUILL", "RIVER", "SOL", "TERRA", "UMBRA", "VEGA", "WREN", "XENO", "YARROW", "ZEPHYR"];

function readState(): State {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State;
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
      archetypes: ARCHETYPES.map((k) => ({ archetype: k, alive: alive.filter((a) => a.archetype === k).length })),
      genes: GENE_SPECS,
      rules: { starveRatio: STARVE_RATIO, bottomQuantile: BOTTOM_QUANTILE, bottomStreakDeath: BOTTOM_STREAK_DEATH, minAgeGens: MIN_AGE_GENS, childShare: CHILD_SHARE },
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
    const scan = await scannerServer.scan();
    const priceOf = new Map(scan.scores.map((s) => [s.market, s.priceKrw]));
    const r = cryptoDesk.rotateTo(sq.targets, priceOf, `${reason} — ${sq.members.map((m) => m.name).join("/")}`);
    this.log(r.error ? "warn" : "ok", r.error ? `DEPLOY refused — ${r.error}` : `DEPLOY squad ${sq.members.map((m) => m.name).join("/")} → paper ledger: ${r.orders.length} orders${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`);
    this.save();
    return { squad: sq, result: r };
  }

  private newAgent(vector: GeneVector, gen: number, parents: string[], seedKrw: number): Agent {
    const genes = toGenes(vector);
    const n = this.st.seedCounter++;
    const name = `${NAMES[n % NAMES.length]}-${String(Math.floor(n / NAMES.length) + 1).padStart(2, "0")}`;
    return {
      id: `ag_${gen}_${n.toString(36)}`, name, archetype: archetypeOf(genes), genes, vector, generationBorn: gen, bornAt: new Date().toISOString(), parents,
      alive: true, diedAt: null, causeOfDeath: null, capitalKrw: seedKrw, seedKrw, peakKrw: seedKrw, exam: null, fitnessHistory: [], capitalHistory: [], lastWeights: [], peers: [], bottomStreak: 0, children: 0,
    };
  }

  private async loadFeatures(): Promise<FeatureSet> {
    const { series } = await scannerServer.series();
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
      const examFrom = f.dates[f.trainEnd], examTo = f.dates[f.dates.length - 1];
      this.log("info", `GEN ${gen} — ${reason} · exam ${examFrom}~${examTo} (${f.dates.length - f.trainEnd} unseen days) · ${f.markets.length} markets`);

      if (this.st.agents.filter((a) => a.alive).length === 0) {
        for (let i = 0; i < POP_MIN; i++) this.st.agents.push(this.newAgent(randomVector(), gen, [], SEED_KRW));
        this.log("info", `genesis — ${POP_MIN} random genomes seeded ₩${SEED_KRW.toLocaleString()} each`);
      }
      const alive = () => this.st.agents.filter((a) => a.alive);

      for (const a of alive()) {
        const r = evaluate(a.genes, f);
        a.exam = { fitness: r.fitness, sharpe: r.sharpe, totalReturnPct: r.totalReturnPct, maxDrawdownPct: r.maxDrawdownPct, rebalances: r.rebalances, avgExposure: r.avgExposure };
        a.fitnessHistory.push({ gen, fitness: r.fitness });
        if (a.fitnessHistory.length > 200) a.fitnessHistory.shift();
        a.lastWeights = r.lastWeights;
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
          a.alive = false; a.diedAt = new Date().toISOString(); a.causeOfDeath = cause;
          this.st.vaultKrw += a.capitalKrw; a.capitalKrw = 0; deaths++;
          this.log("warn", `RETIRED ${a.name} [${a.archetype}] — ${cause}`);
        }
      }

      let births = 0;
      let engine = "none";
      const survivors = alive().sort((a, b) => b.exam!.fitness - a.exam!.fitness);
      const slots = POP_MAX - survivors.length;
      const wanted = Math.min(slots, Math.max(2, Math.ceil(survivors.length * 0.2)));
      if (wanted > 0 && survivors.length >= 2) {
        const ga = await nextGeneration(survivors.map((a) => a.vector), survivors.map((a) => a.exam!.fitness), wanted, gen);
        engine = ga.engine + (ga.version ? `@${ga.version}` : "");
        for (const child of ga.children) {
          const parent = survivors.filter((p) => p.capitalKrw >= p.seedKrw * 0.9).sort((p, q) => geneDistance(p.vector, child) - geneDistance(q.vector, child))[0];
          if (!parent) { this.log("warn", "no parent has surplus over its seed — no births this generation"); break; }
          const seed = parent.capitalKrw * CHILD_SHARE;
          parent.capitalKrw -= seed; parent.children++;
          const kid = this.newAgent(child, gen, [parent.id], seed);
          this.st.agents.push(kid); births++;
          this.log("ok", `BORN ${kid.name} [${kid.archetype}] ← ${parent.name} seeds ₩${Math.round(seed).toLocaleString()} (${engine}: ${Object.values(ga.ops).join("/")})`);
        }
      }

      const finalAlive = alive();
      const fits = finalAlive.map((a) => a.exam?.fitness).filter((x): x is number => typeof x === "number");
      const champion = ranked[0] ?? null;
      const rec: GenerationRecord = {
        gen, at: new Date().toISOString(), examWindow: { from: examFrom, to: examTo }, alive: finalAlive.length, births, deaths,
        topFitness: fits.length ? Math.max(...fits) : 0, meanFitness: fits.length ? +(fits.reduce((a, b) => a + b, 0) / fits.length).toFixed(4) : 0,
        championId: champion?.id ?? null, engine, vaultKrw: Math.round(this.st.vaultKrw), totalCapitalKrw: Math.round(finalAlive.reduce((a, x) => a + x.capitalKrw, 0)),
      };
      this.st.history.push(rec);
      if (this.st.history.length > 500) this.st.history.shift();
      this.st.lastGenerationAt = rec.at;
      mkdirSync(ROOT, { recursive: true });
      appendFileSync(GEN_FILE, JSON.stringify(rec) + "\n");
      this.log("ok", `GEN ${gen} done — survivors ${rec.alive}/${POP_MAX} · births ${births} · deaths ${deaths} · top ${rec.topFitness} (${champion?.name ?? "-"}) · mean ${rec.meanFitness} · engine ${engine}`);
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
