import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { cryptoDesk } from "../crypto/desk.js";
import { scannerServer } from "../crypto/scanner-server.js";
import { handsel, type HandselConnector } from "./handsel-client.js";
import { buildDecision, delegationHeadline, renderConversation, DEFAULT_GATE, type DecisionRecord } from "./decision.js";

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

export interface OfficeRun {
  id: string; // delegation id
  startedAt: string;
  finishedAt: string | null;
  phase: "hiring" | "escrowed" | "working" | "deciding" | "executed" | "rejected" | "failed";
  scope: string;
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

/**
 * 오피스 역할(노드) → 각자 전용 실도구. 네 역할이 같은 툴을 나눠 쓰지 않는다:
 *  chart  → upbit_market_report  (실캔들: 추세·지지/저항·모멘텀, HMM/GARCH 한 줄)
 *  news   → upbit_news_report    (Google News RSS: 출처·날짜·근거어, 없으면 "없음")
 *  quant  → upbit_quant_report   (HMM belief·전이행렬, GARCH, VaR/ES/MDD, Kelly 상한)
 *  rebal  → upbit_rebalance_draft(비중 초안 — 위 셋의 산출물을 브리프로 받아 결정 JSON)
 */
function connectors(): HandselConnector[] {
  const server_url = config.OFFICE_WORKER_URL;
  return [
    { role_id: "chart-analyst", server_url, tool_name: "upbit_market_report", mode: "assisted", label: "us-trading worker — chart desk" },
    { role_id: "news-analyst", server_url, tool_name: "upbit_news_report", mode: "assisted", label: "us-trading worker — news desk" },
    { role_id: "quant-modeler", server_url, tool_name: "upbit_quant_report", mode: "assisted", label: "us-trading worker — quant desk (HMM/GARCH/Kelly)" },
    { role_id: "rebalance-planner", server_url, tool_name: "upbit_rebalance_draft", mode: "assisted", label: "us-trading worker — rebalance desk" },
  ];
}

class OfficeLoop {
  current: OfficeRun | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  status() {
    return {
      enabled: config.OFFICE_LOOP,
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
    const picks = scan.portfolio.targets.map((t) => t.market);
    const pool = picks.length >= 3 ? picks : scan.scores.filter((s) => s.pBull >= 0.5).slice(0, 5).map((s) => s.market);
    if (pool.length < 2) return null;
    const coins = pool.map((m) => m.replace("KRW-", "")).join(", ");
    const scope =
      `${pool.join(", ")} — Upbit crypto basket (${coins}). ` +
      `Final deliverable of the Rebalance proposal MUST end with a fenced json block exactly like ` +
      "```json\n{\"targets\":[{\"market\":\"KRW-XXX\",\"weightPct\":0}],\"cashPct\":0}\n```" +
      ` — one entry per basket market with target weight percent (0 if excluded), weights sum ≤ 100, per-market cap ${DEFAULT_GATE.maxWeightPct}%. This block is machine-read by the trading desk (paper ledger).`;
    return { scope, markets: pool };
  }

  /** 한 사이클: 고용 → escrow → 대기 → 결정 → 관문 → (페이퍼) 실행 */
  async runOnce(opts: { budgetUsd?: number } = {}): Promise<OfficeRun> {
    if (this.running) throw new Error("오피스 사이클이 이미 진행 중");
    if (!handsel.configured()) throw new Error("HANDSEL_MCP_TOKEN 미설정");
    this.running = true;
    const budgetUsd = opts.budgetUsd ?? config.OFFICE_BUDGET_USD;
    const run: OfficeRun = {
      id: "",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      phase: "hiring",
      scope: "",
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

      // 1) 고용 (드래프트만 — 돈 안 움직임)
      const hired = await handsel.hireOffice({
        templateId: "securities-desk",
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

      // 2) escrow (여기서 Handsel USDC가 묶인다 — 테스트넷 기본)
      run.phase = "escrowed";
      try {
        await handsel.confirmDelegation(run.id);
      } catch (e) {
        // 타임아웃이어도 온체인은 갔을 수 있다 — 상태로 재확인 (이중 게시 없음: Handsel 보장)
        logger.warn("confirm_delegation 오류 — 상태로 재확인", { error: (e as Error).message });
        const st = await handsel.delegationStatus();
        const head = delegationHeadline(st, run.id) ?? "";
        if (!/\[posted\]|\[completed\]/.test(head)) await handsel.confirmDelegation(run.id);
      }
      save(run);

      // 3) 오피스가 일하는 동안 대기 (delegation_status 폴링이 정산도 밀어준다)
      run.phase = "working";
      const t0 = Date.now();
      let statusText = "";
      let headline: string | null = null;
      while (Date.now() - t0 < MAX_WAIT_MS) {
        statusText = await handsel.delegationStatus();
        headline = delegationHeadline(statusText, run.id);
        run.headline = headline;
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
      const decision = buildDecision({ delegationId: run.id, output, statusText, gate: { ...DEFAULT_GATE, allowedMarkets: new Set(built.markets) } });
      run.decision = decision;
      const conversation = renderConversation({ delegationId: run.id, headline, decision, output });
      save(run, { conversation });

      // 5) 관문 → 실행 (페이퍼 전용)
      if (!decision.executable) {
        run.phase = "rejected";
        logger.info("오피스 결정 거부 — 실행 안 함", { id: run.id, reasons: decision.reasons });
      } else {
        const scan = await scannerServer.scan();
        const priceOf = new Map(scan.scores.map((s) => [s.market, s.priceKrw]));
        const r = cryptoDesk.rotateTo(decision.targets, priceOf, `office ${run.id} — 채점 통과 결정 (${decision.source})`);
        run.execution = { ts: new Date().toISOString(), orders: r.orders.length, skipped: r.skipped, ...(r.error ? { error: r.error } : {}) };
        run.phase = r.error ? "rejected" : "executed";
      }
    } catch (e) {
      run.error = (e as Error).message;
      run.phase = "failed";
      logger.warn("오피스 사이클 실패", { id: run.id || null, error: run.error });
    } finally {
      run.finishedAt = new Date().toISOString();
      if (run.id) save(run);
      this.current = run;
      this.running = false;
    }
    return run;
  }

  startAutoLoop() {
    if (!config.OFFICE_LOOP || this.timer) return;
    if (!handsel.configured()) {
      logger.warn("OFFICE_LOOP=true 이지만 HANDSEL_MCP_TOKEN 이 없어 오피스 루프를 시작하지 않음");
      return;
    }
    const period = config.OFFICE_INTERVAL_H * 60 * 60_000;
    const run = () => void this.runOnce().catch(() => undefined);
    setTimeout(run, 10 * 60_000).unref(); // 기동 10분 후 첫 사이클 (스캐너 캐시가 채워진 뒤)
    this.timer = setInterval(run, period);
    this.timer.unref();
    logger.info("오피스 결정 루프 예약", { everyHours: config.OFFICE_INTERVAL_H, handsel: handsel.url, budgetUsd: config.OFFICE_BUDGET_USD });
  }
}

export const officeLoop = new OfficeLoop();
