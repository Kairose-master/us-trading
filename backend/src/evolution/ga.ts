import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../core/logger.js";
import { GENE_SPECS, clampGene, rand, type GeneVector } from "./genome.js";

/**
 * 세대 연산자. 기본은 PyGAD(파이썬 서브프로세스, backend/evolution/pygad_step.py) — 진짜
 * 토너먼트 선택·균등 교차·범위 내 변이를 그 라이브러리가 돌린다. 파이썬이나 pygad가
 * 없는 환경(로컬 dev)에서는 같은 의미의 내장 연산자로 대체하고, 결과에 engine을 적어
 * 어느 쪽이 돌았는지 숨기지 않는다.
 */
export interface GaResult {
  engine: "pygad" | "builtin";
  version?: string;
  children: GeneVector[];
  parents: number[]; // population 인덱스
  ops: Record<string, string | number>;
}

const SCRIPT = join(process.cwd(), "evolution", "pygad_step.py");

export async function nextGeneration(population: GeneVector[], fitness: number[], numChildren: number, seed: number): Promise<GaResult> {
  if (population.length >= 2 && existsSync(SCRIPT)) {
    try {
      const r = await runPygad(population, fitness, numChildren, seed);
      if (r.children.length > 0) return r;
      logger.warn("PyGAD returned no new children — falling back to builtin operators");
    } catch (e) {
      logger.warn("PyGAD unavailable — builtin operators", { error: (e as Error).message.slice(0, 200) });
    }
  }
  return builtin(population, fitness, numChildren);
}

function runPygad(population: GeneVector[], fitness: number[], numChildren: number, seed: number): Promise<GaResult> {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { py.kill(); reject(new Error("pygad timeout")); }, 60_000);
    py.stdout.on("data", (d) => (out += d));
    py.stderr.on("data", (d) => (err += d));
    py.on("error", (e) => { clearTimeout(timer); reject(e); });
    py.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`pygad exit ${code}: ${err.slice(-300)}`));
      try {
        const j = JSON.parse(out) as { engine: "pygad"; version: string; children: GeneVector[]; parents?: number[]; ops?: Record<string, string | number> };
        resolve({ engine: "pygad", version: j.version, children: j.children.map((c) => c.map((v, i) => clampGene(GENE_SPECS[i], v))), parents: j.parents ?? [], ops: j.ops ?? {} });
      } catch (e) {
        reject(new Error(`pygad output unparseable: ${(e as Error).message}`));
      }
    });
    py.stdin.write(JSON.stringify({ population, fitness, gene_space: GENE_SPECS.map((g) => ({ min: g.min, max: g.max, int: g.int })), num_children: numChildren, num_parents: Math.max(2, Math.ceil(population.length / 2)), seed, mutation_percent_genes: 20 }));
    py.stdin.end();
  });
}

/** 내장 대체: 토너먼트(3) 선택 → 균등 교차 → 유전자 20% 가우시안 변이 */
function builtin(population: GeneVector[], fitness: number[], numChildren: number): GaResult {
  const n = population.length;
  const pick = () => {
    let best = Math.floor(rand() * n);
    for (let k = 0; k < 2; k++) { const c = Math.floor(rand() * n); if ((fitness[c] ?? -Infinity) > (fitness[best] ?? -Infinity)) best = c; }
    return best;
  };
  const children: GeneVector[] = [];
  const parents = new Set<number>();
  for (let c = 0; c < numChildren; c++) {
    const a = n >= 1 ? pick() : 0, b = n >= 2 ? pick() : a;
    parents.add(a); parents.add(b);
    const child = GENE_SPECS.map((g, i) => {
      let v = rand() < 0.5 ? population[a][i] : population[b][i];
      if (rand() < 0.2) v += (rand() - 0.5) * 0.3 * (g.max - g.min); // 변이
      return clampGene(g, v);
    });
    children.push(child);
  }
  return { engine: "builtin", children, parents: [...parents], ops: { selection: "tournament3", crossover: "uniform", mutation: "gaussian20%" } };
}
