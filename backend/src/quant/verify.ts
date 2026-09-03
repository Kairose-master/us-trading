import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../core/logger.js";

/**
 * 검증 사이드카 브리지 — SPA(Hansen)는 정지 부트스트랩이 필요해서 직접 짜지 않는다.
 * arch(Kevin Sheppard)에 맡기고, 없으면 **숫자를 지어내지 않고** engine:"unavailable"로 답한다.
 * PyGAD 브리지(ga.ts)와 같은 규칙: 폴백이 있으면 결과에 engine을 적는다. 여기는 폴백이 없다 —
 * "p값을 못 쟀다"와 "p값이 크다"는 다른 말이고, 섞으면 그게 가짜 데이터다.
 */

/** 컨테이너는 /app/quant, 로컬 dev는 backend/quant — 실행 위치와 무관하게 찾는다 */
function findScript(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/quant 또는 src/quant
  for (const c of [join(process.cwd(), "quant", "verify.py"), resolve(here, "..", "..", "quant", "verify.py"), resolve(here, "..", "..", "..", "quant", "verify.py")]) {
    if (existsSync(c)) return c;
  }
  return join(process.cwd(), "quant", "verify.py"); // 없을 때의 보고용 경로
}
const SCRIPT = findScript();
const TIMEOUT_MS = 60_000;

export interface SpaRequest { benchmark: number[]; models: Record<string, number[]>; reps?: number; blockSize?: number; seed?: number }
export interface SpaOk {
  engine: "arch";
  version: string;
  n: number;
  models: number;
  reps: number;
  blockSize: number;
  /** lower/consistent/upper — consistent가 보고용 기본값 */
  pvalues: { lower: number | null; consistent: number | null; upper: number | null };
  best: { name: string; meanLossDiff: number };
  meanLossDiff: Record<string, number>;
  /** StepM(Romano-Wolf)이 FWER 5%에서 벤치마크를 이겼다고 인정한 모델 */
  superiorModels: string[] | null;
}
export interface SpaUnavailable { engine: "unavailable"; reason: string }
export type SpaResult = SpaOk | SpaUnavailable;

export function spaAvailable(): boolean { return existsSync(SCRIPT); }

function run(payload: unknown): Promise<SpaResult> {
  return new Promise((resolve) => {
    if (!existsSync(SCRIPT)) return resolve({ engine: "unavailable", reason: `verify.py not found at ${SCRIPT}` });
    let out = "", err = "", done = false;
    const finish = (r: SpaResult) => { if (!done) { done = true; resolve(r); } };
    let py: ReturnType<typeof spawn>;
    try { py = spawn("python3", [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { return finish({ engine: "unavailable", reason: (e as Error).message }); }
    const timer = setTimeout(() => { try { py.kill("SIGKILL"); } catch { /* already gone */ } finish({ engine: "unavailable", reason: `timed out after ${TIMEOUT_MS}ms` }); }, TIMEOUT_MS);
    py.stdout?.on("data", (d) => { out += String(d); });
    py.stderr?.on("data", (d) => { err += String(d); });
    py.on("error", (e) => { clearTimeout(timer); finish({ engine: "unavailable", reason: e.message }); });
    py.on("close", () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
        if (j.error) return finish({ engine: "unavailable", reason: String(j.error) });
        if (j.engine !== "arch") return finish({ engine: "unavailable", reason: `unexpected response: ${out.slice(0, 200)}` });
        finish(j as unknown as SpaOk);
      } catch {
        finish({ engine: "unavailable", reason: (err || out).slice(0, 300) || "no output" });
      }
    });
    py.stdin?.write(JSON.stringify(payload));
    py.stdin?.end();
  });
}

/** 손실 = 수익률의 음수 (작을수록 좋다) */
export const toLosses = (returns: number[]) => returns.map((r) => -r);

/** 공통 날짜 축에서 일간 수익률을 뽑는다 — 벤치마크와 후보의 길이를 맞추는 순수 함수 */
export function alignedReturns(
  closeOf: Map<string, Map<string, number>>,
  dates: string[],
  markets: string[],
): { dates: string[]; returns: Record<string, number[]> } {
  const usable = dates.filter((d) => markets.every((m) => (closeOf.get(m)?.get(d) ?? 0) > 0));
  const returns: Record<string, number[]> = {};
  for (const m of markets) {
    const c = closeOf.get(m)!;
    returns[m] = usable.slice(1).map((d, i) => c.get(d)! / c.get(usable[i])! - 1);
  }
  return { dates: usable.slice(1), returns };
}

export async function spaTest(req: SpaRequest): Promise<SpaResult> {
  const r = await run({ op: "spa", ...req });
  if (r.engine === "unavailable") logger.warn("[verify] SPA unavailable — reporting 'not measured', not a p-value", { reason: r.reason.slice(0, 160) });
  return r;
}

export async function verifyPing(): Promise<SpaResult> { return run({ op: "ping" }); }
