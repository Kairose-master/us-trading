import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { controlPlane } from "../control/plane.js";
import { scannerServer } from "../crypto/scanner-server.js";
import { handsel, type HandselConnector } from "./handsel-client.js";
import { buildDecision, delegationHeadline, renderConversation, DEFAULT_GATE, type DecisionRecord } from "./decision.js";
import { OFFICE_ROSTER, OFFICE_STEP_COUNT, OFFICE_TEMPLATE_ID, roleForStep } from "./roster.js";
import { deliberateLocally } from "./local-office.js";
import { buildOfficeCandidates, OFFICE_CANDIDATES_MAX } from "./candidates.js";
import { MAJORS } from "../crypto/universe.js";

/**
 * 오피스 결정 루프 — "모델들이 대화하고, 자율 결정하고, 그 결정이 매매가 된다."
 *
 *   1. 스캐너가 후보 유니버스를 고른다 (비용·유동성 필터를 통과한 코인)
 *   2. Handsel 증권 오피스를 고용한다 — 차트·뉴스·퀀트·리밸런스 4 에이전트가
 *      각자 실도구(MCP 워커)로 조사하고, 서로의 산출물을 브리프로 받아 대화한다
 *   3. 각 산출물은 Handsel 독립 채점을 거친다 — 통과해야 보수가 나가고,
 *      **통과한 결정만 매매가 된다** (pay-only-on-pass = 매매 QA 관문)
 *   4. 최종 산출물을 conversation.md(원문)·decision.json(구조화)·
 *      execution.json(체결)로 볼륨에 남기고, 페이퍼 장부를 타깃대로 회전한다
 *
 * 실돈 경계: Handsel 쪽은 HANDSEL_MCP_URL(기본 테스트넷)의 USDC, 매매 쪽은
 * 페이퍼 장부 전용(desk.rotateTo가 실주문 모드면 거부). 둘 다 명시 플래그
 * 없이는 실돈에 닿지 않는다.
 */

const ROOT = join(process.cwd(), "data", "office");
const POLL_MS = 60_000;
const MAX_WAIT_MS = 6 * 60 * 60_000; // 오피스가 6시간 안에 못 끝내면 이번 사이클 포기
// escrow(confirm_delegation)가 번들러 타임아웃으로 실패하면 — 2026-09-02 Base Sepolia에서
// 하루 종일 그랬다 — 새 오피스를 또 고용하지 말고 같은 딜리게이션을 30분마다 다시 민다.
// Handsel은 중복 게시를 막으므로 재시도는 안전하고, planned 딜리게이션은 돈이 안 묶인다.
const ESCROW_RETRY_MS = 30 * 60_000;
const ESCROW_RETRY_MAX = 8; // 4시간까지
const RESUME_WINDOW_MS = 24 * 60 * 60_000; // 재기동 시 이 안의 미완 run만 이어받는다

export interface OfficeRun {
  id: string; // delegation id (handsel) 또는 loc-… (local)
  /** 협의가 어디서 돌았나 — 구 run.json에는 없다 → handsel */
  mode?: "handsel" | "local";
  startedAt: string;
  finishedAt: string | null;
  phase: "hiring" | "escrowed" | "escrow-pending" | "working" | "deciding" | "executed" | "rejected" | "failed";
  scope: string;
  /** 바스켓 마켓 — 결정 관문의 allowedMarkets. 구 run.json에는 없어 scope에서 복원한다 */
  markets?: string[];
  /** escrow 재시도 횟수 (escrow-pending에서만 의미) */
  retries?: number;
  /** 이 run이 고용한 오피스의 단계 수 (구 4단계 run.json에는 없다 → 4) */
  steps?: number;
  /** 폴링마다 갱신되는 단계별 채점 상태 — 그래프가 실시간으로 읽는다 (role id → 상태) */
  stepStatuses?: Record<string, string>;
  budgetUsd: number;
  headline: string | null;
  decision: DecisionRecord | null;
  execution: { ts: string; orders: number; skipped: string[]; error?: string } | null;
  error: string | null;
}

function runDir(id: string) {
  return join(ROOT, id);
}
function save(run: OfficeRun, extra?: { conversation?: string }) {
  const dir = runDir(run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify(run, null, 2));
  if (run.decision) writeFileSync(join(dir, "decision.json"), JSON.stringify(run.decision, null, 2));
  if (run.execution) writeFileSync(join(dir, "execution.json"), JSON.stringify(run.execution, null, 2));
  if (extra?.conversation) writeFileSync(join(dir, "conversation.md"), extra.conversation);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** delegation_status 텍스트 → { roleId: 상태 }. 로스터 접두와 안 맞는 단계는 단계명 그대로 키 */
function stepStatusesByRole(statusText: string, delegationId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const st of buildDecision({ delegationId, output: "", statusText }).steps) {
    const role = roleForStep(st.name);
    out[role ? role.id : st.name] = st.status;
  }
  return out;
}

/** 로스터(office/roster.ts) → hire_office 커넥터. 툴이 있는 역할만; 위원장은 플랫폼 에이전트 */
function connectors(): HandselConnector[] {
  const server_url = config.OFFICE_WORKER_URL;
  return OFFICE_ROSTER.filter((r) => r.tool).map((r) => ({
    role_id: r.id,
    server_url,
    tool_name: r.tool!,
    mode: "assisted" as const,
    label: `us-trading worker — ${r.name}`,
  }));
}

class OfficeLoop {
  current: OfficeRun | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  status() {
    return {
      enabled: config.OFFICE_LOOP,
      mode: config.OFFICE_MODE,
      configured: handsel.configured(),
      handselUrl: handsel.url,
      realMoneyHandsel: handsel.isRealMoney(),
      allowRealMoney: config.OFFICE_ALLOW_REAL_MONEY,
      budgetUsd: config.OFFICE_BUDGET_USD,
      intervalHours: config.OFFICE_INTERVAL_H,
      running: this.running,
      current: this.current,
      gate: DEFAULT_GATE,
    };
  }

  list(): OfficeRun[] {
    if (!existsSync(ROOT)) return [];
    return readdirSync(ROOT)
      .map((id) => {
        try {
          return JSON.parse(readFileSync(join(ROOT, id, "run.json"), "utf-8")) as OfficeRun;
        } catch {
          return null;
        }
      })
      .filter((r): r is OfficeRun => r !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): { run: OfficeRun; conversation: string | null } | null {
    const dir = runDir(id);
    if (!existsSync(join(dir, "run.json"))) return null;
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf-8")) as OfficeRun;
    const conv = existsSync(join(dir, "conversation.md")) ? readFileSync(join(dir, "conversation.md"), "utf-8") : null;
    return { run, conversation: conv };
  }

  /** 스캐너 유니버스 → 오피스 스코프 문자열. 후보가 없으면 null (오피스를 안 부른다) */
  async buildScope(): Promise<{ scope: string; markets: string[] } | null> {
    const scan = await scannerServer.scan();
    // 후보 = 메이저 + 보유분 + 60일 위험조정 상위 (20일 +40% 이상 과열 제외). 스캐너 상위 5개(=20일 모멘텀 1등들)를 그대로 넘기던 것을 끝냈다
    const held = controlPlane.status().holdings.map((h) => h.market);
    const cand = buildOfficeCandidates({ scores: scan.scores, majors: MAJORS, held, max: OFFICE_CANDIDATES_MAX });
    const pool = cand.markets;
    if (pool.length < 2) return null;
    logger.info("[office] candidates", { markets: pool.map((m) => m.slice(4)), notes: cand.notes });
    const coins = pool.map((m) => m.replace("KRW-", "")).join(", ");
    const scope =
      `${pool.join(", ")} — Upbit crypto basket (${coins}). Candidates are the majors, current holdings and the top names by 60-day risk-adjusted return; names up more than ${40}% in 20 days are excluded as overheated. "No positions" (all weights 0) is a valid decision. ` +
      `The FINAL deliverable (Investment committee decision) MUST end with a fenced json block exactly like ` +
      "```json\n{\"targets\":[{\"market\":\"KRW-XXX\",\"weightPct\":0}],\"cashPct\":0}\n```" +
      ` — one entry per basket market with target weight percent (0 if excluded), weights sum ≤ 100, per-market cap ${DEFAULT_GATE.maxWeightPct}%. This block is machine-read by the trading desk (paper ledger).`;
    return { scope, markets: pool };
  }

  /** 이어받을 수 있는 run — escrow 대기 중이거나 재기동으로 끊긴 것 (24h 이내) */
  resumable(): OfficeRun | null {
    const now = Date.now();
    for (const r of this.list()) {
      if (r.mode === "local") continue; // 로컬 협의는 에스크로가 없어 이어받을 것도 없다
      if (now - Date.parse(r.startedAt) > RESUME_WINDOW_MS) continue;
      if (r.phase === "escrow-pending" || r.phase === "escrowed" || r.phase === "working" || r.phase === "deciding") return r;
      // 이 코드가 들어가기 전 빌드가 남긴 형태: confirm 실패를 곧바로 failed로 적었다
      if (r.phase === "failed" && /confirm_delegation/.test(r.error ?? "")) return r;
    }
    return null;
  }

  /** 한 사이클: (이어받을 run이 있으면 그것부터) 고용 → escrow → 대기 → 결정 → 관문 → (페이퍼) 실행 */
  async runOnce(opts: { budgetUsd?: number; resume?: boolean; mode?: "handsel" | "local" } = {}): Promise<OfficeRun> {
    if (this.running) throw new Error("오피스 사이클이 이미 진행 중");
    const mode = opts.mode ?? config.OFFICE_MODE;
    if (mode === "local") return this.runLocal();
    if (!handsel.configured()) throw new Error("HANDSEL_MCP_TOKEN 미설정 — OFFICE_MODE=local 이면 에스크로 없이 돈다");
    const pending = opts.resume === false ? null : this.resumable();
    if (pending) {
      logger.info("미완 오피스 run 이어받음", { id: pending.id, phase: pending.phase, retries: pending.retries ?? 0 });
      return this.continueRun(pending);
    }
    this.running = true;
    const budgetUsd = opts.budgetUsd ?? config.OFFICE_BUDGET_USD;
    const run: OfficeRun = {
      id: "",
      mode: "handsel",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      phase: "hiring",
      scope: "",
      markets: [],
      retries: 0,
      steps: OFFICE_STEP_COUNT,
      budgetUsd,
      headline: null,
      decision: null,
      execution: null,
      error: null,
    };
    try {
      const built = await this.buildScope();
      if (!built) throw new Error("스캐너 후보가 2개 미만 — 오피스를 부르지 않음 (현금 유지)");
      run.scope = built.scope;
      run.markets = built.markets;

      // 1) 고용 (드래프트만 — 돈 안 움직임)
      const hired = await handsel.hireOffice({
        templateId: OFFICE_TEMPLATE_ID,
        scope: built.scope,
        budgetUsd,
        office: config.OFFICE_SLOT,
        primeAgentId: config.HANDSEL_PRIME_AGENT_ID || undefined,
        connectors: connectors(),
      });
      const idm = /delegation_id:\s*(dlg-[A-Za-z0-9_-]+)/.exec(hired);
      if (!idm) throw new Error(`hire_office 응답에서 delegation_id 없음: ${hired.slice(0, 200)}`);
      run.id = idm[1];
      this.current = run;
      save(run);
    } catch (e) {
      run.error = (e as Error).message;
      run.phase = "failed";
      run.finishedAt = new Date().toISOString();
      logger.warn("오피스 고용 실패", { error: run.error });
      if (run.id) save(run);
      this.current = run;
      this.running = false;
      return run;
    }
    this.running = false;
    return this.continueRun(run);
  }

  /** 고용된 run을 끝까지: escrow → 대기 → 결정 → 관문 → 실행. escrow가 안 되면 escrow-pending으로 두고 재시도를 건다 */
  private async continueRun(run: OfficeRun): Promise<OfficeRun> {
    if (this.running) throw new Error("오피스 사이클이 이미 진행 중");
    this.running = true;
    this.current = run;
    run.finishedAt = null;
    const markets = run.markets?.length ? run.markets : (run.scope.match(/KRW-[A-Z0-9]+/g) ?? []);
    try {
      // 2) escrow (여기서 Handsel USDC가 묶인다 — 테스트넷 기본)
      if (run.phase === "hiring" || run.phase === "escrowed" || run.phase === "escrow-pending" || run.phase === "failed") {
        run.phase = "escrowed";
        run.error = null;
        save(run);
        const posted = await this.escrow(run);
        if (!posted) {
          run.retries = (run.retries ?? 0) + 1;
          if (run.retries > ESCROW_RETRY_MAX) {
            throw new Error(`escrow ${ESCROW_RETRY_MAX}회 재시도 실패 — 포기: ${run.error}`);
          }
          run.phase = "escrow-pending";
          save(run);
          logger.warn("escrow 실패 — 재시도 예약", { id: run.id, retries: run.retries, inMin: ESCROW_RETRY_MS / 60_000, error: run.error });
          setTimeout(() => void this.runOnce().catch(() => undefined), ESCROW_RETRY_MS).unref();
          this.running = false;
          return run;
        }
      }

      // 3) 오피스가 일하는 동안 대기 (delegation_status 폴링이 정산도 밀어준다)
      run.phase = "working";
      run.error = null;
      save(run);
      const t0 = Date.now();
      let statusText = "";
      let headline: string | null = null;
      while (Date.now() - t0 < MAX_WAIT_MS) {
        statusText = await handsel.delegationStatus();
        headline = delegationHeadline(statusText, run.id);
        run.headline = headline;
        run.stepStatuses = stepStatusesByRole(statusText, run.id);
        save(run);
        if (headline && /\[completed\]/.test(headline)) break;
        // 실패로 끝난 단계가 있으면 더 기다릴 이유가 없다 (환불은 Handsel이)
        const steps = buildDecision({ delegationId: run.id, output: "", statusText }).steps;
        if (steps.some((s) => s.status === "❌" || s.status === "Expired")) break;
        await sleep(POLL_MS);
      }

      // 4) 결정
      run.phase = "deciding";
      const output = await handsel.getDelegationOutput(run.id);
      await this.finish(run, { output, statusText, headline, markets });
    } catch (e) {
      run.error = (e as Error).message;
      run.phase = "failed";
      run.finishedAt = new Date().toISOString();
      logger.warn("오피스 사이클 실패", { id: run.id, error: run.error });
    } finally {
      save(run);
      this.current = run;
      this.running = false;
    }
    return run;
  }

  /** 로컬 협의 — 같은 로스터, 에스크로 없음. 각 역할이 실도구를 직접 부르고 검토·수정 라운드를 여기서 돈다 */
  private async runLocal(): Promise<OfficeRun> {
    this.running = true;
    const run: OfficeRun = {
      id: `loc-${Date.now().toString(36)}`,
      mode: "local",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      phase: "working",
      scope: "",
      markets: [],
      retries: 0,
      steps: OFFICE_STEP_COUNT,
      stepStatuses: {},
      budgetUsd: 0,
      headline: null,
      decision: null,
      execution: null,
      error: null,
    };
    this.current = run;
    try {
      const built = await this.buildScope();
      if (!built) throw new Error("스캐너 후보가 2개 미만 — 오피스를 부르지 않음 (현금 유지)");
      run.scope = built.scope;
      run.markets = built.markets;
      save(run);
      const d = await deliberateLocally(built.markets, (roleId, status) => { run.stepStatuses = { ...(run.stepStatuses ?? {}), [roleId]: status }; save(run); });
      // 로컬 채점 결과를 delegation_status 형식으로 — buildDecision/parseSteps가 그대로 읽는다
      const statusText = [`${run.id} [completed] ${d.headline}`, ...d.steps.map((s) => `  - ${s.status} ${s.name} — ${s.note}`)].join("\n");
      run.phase = "deciding";
      await this.finish(run, { output: d.output, statusText, headline: `${run.id} [completed] ${d.headline}`, markets: built.markets });
    } catch (e) {
      run.error = (e as Error).message;
      run.phase = "failed";
      run.finishedAt = new Date().toISOString();
      logger.warn("로컬 오피스 협의 실패", { id: run.id, error: run.error });
    } finally {
      save(run);
      this.current = run;
      this.running = false;
    }
    return run;
  }

  /** 결정 파싱 → 관문 → 제어 평면 제안 (handsel·local 공통 꼬리) */
  private async finish(run: OfficeRun, p: { output: string; statusText: string; headline: string | null; markets: string[] }) {
    const { output, statusText, headline, markets } = p;
    run.headline = headline;
    {
      const decision = buildDecision({ delegationId: run.id, output, statusText, expectedSteps: run.steps ?? 4, gate: { ...DEFAULT_GATE, allowedMarkets: new Set(markets) } });
      run.decision = decision;
      const conversation = renderConversation({ delegationId: run.id, headline, decision, output });
      save(run, { conversation });

      // 5) 관문 → 실행 (페이퍼 전용)
      if (!decision.executable) {
        run.phase = "rejected";
        logger.info("오피스 결정 거부 — 실행 안 함", { id: run.id, reasons: decision.reasons });
      } else {
        // 장부 직접 회전 대신 제어 평면 제안 — 확신도는 위원장이 퀀트 우위(t값)에서 유도한 값. 없으면(구 Handsel 산출물) 통과 단계 비율
        const passed = decision.steps.filter((x) => x.status === "Completed").length;
        const confidence = decision.confidence ?? (decision.steps.length ? passed / decision.steps.length : 0);
        const { decision: dc } = await controlPlane.propose({
          engine: "office",
          targets: decision.targets,
          confidence,
          evidence: `${run.id} (${run.mode ?? "handsel"}) · ${passed}/${decision.steps.length} ${run.mode === "local" ? "locally accepted" : "graded"} steps passed · confidence ${confidence.toFixed(2)}${decision.confidence === null ? " (step ratio)" : " (quant edge)"} · source ${decision.source}`,
          ref: run.id,
        });
        const ex = dc?.execution;
        run.execution = { ts: new Date().toISOString(), orders: ex?.orders ?? 0, skipped: ex?.skipped ?? [], ...(dc?.status === "executed" ? {} : { error: `control plane: ${dc?.status ?? "no decision"}${dc?.status === "pending" ? " (owner approval)" : ""}` }) };
        // 협의회가 "거래할 가치 없음"으로 건너뛴 것은 오피스 결정의 거부가 아니다 — 결정은 유효했고 장부가 이미 그 근처에 있었을 뿐
        run.phase = dc?.status === "executed" || dc?.status === "pending" || dc?.status === "skipped" ? "executed" : "rejected";
      }
      run.finishedAt = new Date().toISOString();
    }
  }

  /** confirm_delegation → 실제로 [posted]/[completed]가 됐는지로 판정. 오류 문자열은 run.error에 남긴다 */
  private async escrow(run: OfficeRun): Promise<boolean> {
    const isPosted = async () => {
      const head = delegationHeadline(await handsel.delegationStatus(), run.id) ?? "";
      return /\[posted\]|\[completed\]/.test(head);
    };
    // 지난 시도의 트랜잭션이 늦게 올라왔을 수 있다 — 먼저 상태부터
    if (await isPosted()) return true;
    try {
      await handsel.confirmDelegation(run.id);
    } catch (e) {
      // 타임아웃이어도 온체인은 갔을 수 있다 — 상태로 재확인 (이중 게시 없음: Handsel 보장)
      run.error = (e as Error).message;
      logger.warn("confirm_delegation 오류 — 상태로 재확인", { id: run.id, error: run.error });
    }
    if (await isPosted()) return true;
    if (!run.error) {
      // 예외 없이 끝났는데 posted가 아니면 Handsel이 딜리게이션에 남긴 오류를 가져온다
      const head = delegationHeadline(await handsel.delegationStatus(), run.id) ?? "";
      run.error = `confirm_delegation 후에도 planned: ${head.slice(0, 300)}`;
    }
    return false;
  }

  startAutoLoop() {
    if (!config.OFFICE_LOOP || this.timer) return;
    if (config.OFFICE_MODE === "handsel" && !handsel.configured()) {
      logger.warn("OFFICE_LOOP=true 이지만 HANDSEL_MCP_TOKEN 이 없어 오피스 루프를 시작하지 않음");
      return;
    }
    const period = config.OFFICE_INTERVAL_H * 60 * 60_000;
    const run = () => void this.runOnce().catch(() => undefined);
    // 재기동으로 끊긴 run(escrow 대기·작업 중)은 곧바로 이어받고, 새 사이클은 10분 뒤(스캐너 캐시 이후)
    const firstDelay = config.OFFICE_MODE === "handsel" && this.resumable() ? 30_000 : 10 * 60_000;
    setTimeout(run, firstDelay).unref();
    this.timer = setInterval(run, period);
    this.timer.unref();
    logger.info("오피스 결정 루프 예약", { mode: config.OFFICE_MODE, everyHours: config.OFFICE_INTERVAL_H, handsel: handsel.url, budgetUsd: config.OFFICE_BUDGET_USD, resume: this.resumable()?.id ?? null });
  }
}

export const officeLoop = new OfficeLoop();
