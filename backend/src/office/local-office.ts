import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { mcpCall } from "../evolution/capabilities.js";
import { parseChart, parseFlow, parseMacro, parseNews, parseRisk } from "../evolution/capabilities.js";
import { OFFICE_ROSTER, type OfficeRole, type OfficeRoleId } from "./roster.js";
import { DEFAULT_GATE } from "./decision.js";

/**
 * 로컬 오피스 협의 — Handsel 에스크로 없이 같은 9역할 플로어를 백엔드 안에서 돌린다.
 *
 * 구조는 Handsel 템플릿과 1:1 (roster.ts 단일 정의): dependsOn = 핸드오프(상류 보고서가
 * 브리프로 주입), reviewOf = 동료 검토(REVISE면 대상 역할이 수정본을 내는 협상 라운드,
 * 최대 2회), chair = 합의(전부 읽고 결정 JSON 하나). 차이는 세 가지다:
 *   - 돈이 안 묶인다. 에스크로도, 채점 보상도 없다.
 *   - "채점"이 Handsel의 독립 채점자가 아니라 여기의 **기계적 수락 조건**이다 (보고서에
 *     실데이터 섹션이 있는가, 검토가 결론을 냈는가, 위원장 JSON이 관문을 지키는가).
 *   - 산문을 쓰는 LLM이 없다. 각 역할의 산출물은 실도구 보고서 + 그것을 읽는 결정적 규칙이다.
 *     지어내는 문장이 없다는 뜻이고, 그래서 Handsel 오피스보다 덜 유창하고 더 정직하다.
 *
 * 돈 경계: 산출물은 제어 평면 제안으로만 나간다 (loop.ts). 실주문 경로 없음.
 */

export interface LocalStep { role: OfficeRoleId; name: string; status: "Completed" | "❌"; ms: number; note: string }
export interface LocalDeliberation { output: string; steps: LocalStep[]; rounds: number; headline: string; toolCalls: number }

const MAX_REVIEW_ROUNDS = 2;
const sym = (m: string) => m.replace("KRW-", "");

/** 워커 보고서가 "데이터 없음"으로 돌아오면(대개 Upbit 429 버스트) 1.5초 뒤 한 번 더 — 재시도해도 없으면 그대로 실패로 기록 */
const NO_DATA = /Need at least 2 coins[^\n]*got 0|캔들 부족|no data \(skipped, not invented\)\s*$|no order-book\/trade data/m;
async function tool(role: OfficeRole, query: string): Promise<{ text: string; ms: number; retried: boolean }> {
  const t0 = Date.now();
  let text = await mcpCall("worker", role.tool!, { query }, 90_000);
  let retried = false;
  if (NO_DATA.test(text) && !/^## KRW-[A-Z0-9]+ — [^\n]*(₩|headlines|mid ₩|returns)/m.test(text)) {
    await new Promise((r) => setTimeout(r, 1500));
    text = await mcpCall("worker", role.tool!, { query }, 90_000);
    retried = true;
  }
  return { text, ms: Date.now() - t0, retried };
}

/** 보고서에 실데이터 섹션이 있는가 — 기계적 수락 조건 */
function hasSections(text: string, markets: string[]): string[] {
  return markets.filter((m) => new RegExp(`^## ${m}\\b(?!.*no data)`, "m").test(text) && !new RegExp(`^## ${m} — no data`, "m").test(text));
}

interface Draft { targets: Array<{ market: string; weightPct: number; why: string }>; grossPct: number; version: number; notes: string[] }

function fmtDraft(d: Draft): string {
  return [
    `Draft v${d.version} — gross ${d.grossPct.toFixed(1)}%, cash ${(100 - d.grossPct).toFixed(1)}%`,
    ...d.targets.map((t) => `  ${t.market}: ${t.weightPct.toFixed(1)}% — ${t.why}`),
    ...d.notes.map((n) => `  note: ${n}`),
  ].join("\n");
}

export async function deliberateLocally(markets: string[], onStep?: (role: OfficeRoleId, status: string) => void): Promise<LocalDeliberation> {
  const steps: LocalStep[] = [];
  const sections: string[] = [];
  const coins = markets.map(sym);
  const q = coins.join(" ");
  let toolCalls = 0;
  let rounds = 0;
  const role = (id: OfficeRoleId) => OFFICE_ROSTER.find((r) => r.id === id)!;
  const head = (r: OfficeRole) => `## ${r.stepTitle} — ${r.name}`;
  const mark = (r: OfficeRole, status: LocalStep["status"], ms: number, note: string) => { steps.push({ role: r.id, name: r.stepTitle, status, ms, note }); onStep?.(r.id, status); };
  const start = (r: OfficeRole) => onStep?.(r.id, "Claimed");

  // ── 1) 애널리스트 4명 (병렬, 상류 없음) ─────────────────────────────────────
  const analysts: OfficeRoleId[] = ["chart-analyst", "news-analyst", "flow-analyst", "macro-analyst"];
  const reports: Partial<Record<OfficeRoleId, string>> = {};
  await Promise.all(analysts.map(async (id) => {
    const r = role(id); start(r);
    try {
      const { text, ms } = await tool(r, id === "macro-analyst" ? "crypto basket risk read" : q); toolCalls++;
      reports[id] = text;
      const ok = id === "macro-analyst" ? /read: (risk-on|risk-off|mixed)/.test(text) : hasSections(text, markets).length > 0;
      mark(r, ok ? "Completed" : "❌", ms, ok ? (id === "macro-analyst" ? parseMacro(text) : `${hasSections(text, markets).length}/${markets.length} markets reported`) : "no real-data section — not accepted");
    } catch (e) { reports[id] = `(tool failed: ${(e as Error).message})`; mark(r, "❌", 0, (e as Error).message.slice(0, 120)); }
  }));
  for (const id of analysts) sections.push(`${head(role(id))}\n\n${reports[id] ?? ""}`);

  const chart = parseChart(reports["chart-analyst"] ?? "");
  const news = parseNews(reports["news-analyst"] ?? "");
  const flow = parseFlow(reports["flow-analyst"] ?? "");
  const macro = parseMacro(reports["macro-analyst"] ?? "");

  // ── 2) 퀀트 모델러 (상류 4 보고서 핸드오프 + 자기 도구) ───────────────────────
  const quant = role("quant-modeler"); start(quant);
  let quantText = "";
  let quantMs = 0;
  try { const r = await tool(quant, q); toolCalls++; quantText = r.text; quantMs = r.ms; } catch (e) { quantText = `(tool failed: ${(e as Error).message})`; }
  const sigma = new Map<string, number>();
  const kellyHalf = new Map<string, number>();
  for (const sec of quantText.split(/\n(?=## )/)) {
    const m = sec.match(/^## (KRW-[A-Z0-9]+)/); if (!m) continue;
    const s = sec.match(/σ_next=([\d.]+)%\/d/); if (s) sigma.set(m[1], Number(s[1]));
    const k = sec.match(/half=([\d.-]+)/); if (k) kellyHalf.set(m[1], Number(k[1]));
  }
  // 모델 뷰: 상류 보고서를 점수로 — 차트(추세/국면) + 뉴스 감성 + 수급 + 매크로. 전부 보고서에서 읽은 숫자
  const scored = markets.map((mkt) => {
    const c = chart.find((x) => x.market === mkt), n = news.find((x) => x.market === mkt), f = flow.find((x) => x.market === mkt);
    let score = 0; const why: string[] = [];
    if (c) { if (c.above === true) { score += 1; why.push("above MA20"); } else if (c.above === false) { score -= 1; why.push("below MA20"); } if (c.regime && /약세/.test(c.regime) && (c.pBear ?? 0) > (c.pBull ?? 0)) { score -= 1; why.push(`regime ${c.regime}`); } else if (c.regime) why.push(`regime ${c.regime}`); }
    if (n) { score += Math.max(-1, Math.min(1, n.score * 2)); why.push(`news ${n.label} ${n.score >= 0 ? "+" : ""}${n.score}`); }
    if (f) { const tilt = (f.imbalance ?? 0) * 0.5 + ((f.buyShare ?? 0.5) - 0.5); score += Math.max(-0.5, Math.min(0.5, tilt)); why.push(`flow imb ${f.imbalance === null ? "?" : (f.imbalance * 100).toFixed(0) + "%"} buy ${f.buyShare === null ? "?" : (f.buyShare * 100).toFixed(0) + "%"}`); }
    return { market: mkt, score: +score.toFixed(3), sigma: sigma.get(mkt) ?? null, kelly: kellyHalf.get(mkt) ?? null, why: why.join(", ") };
  });
  const picks = scored.filter((s) => s.score > 0 && s.sigma !== null && s.sigma > 0);
  const inv = picks.map((p) => 1 / p.sigma!); const invSum = inv.reduce((a, b) => a + b, 0) || 1;
  let exposure = macro === "risk-off" ? 0.5 : macro === "mixed" ? 0.75 : macro === "risk-on" ? 0.9 : 0.6;
  const draft: Draft = { version: 1, targets: [], grossPct: 0, notes: [`macro ${macro} → exposure budget ${(exposure * 100).toFixed(0)}%`] };
  picks.forEach((p, i) => {
    let w = (inv[i] / invSum) * exposure * 100;
    // Kelly½ = 노출 상한. 양수면 그대로, 0 이하(200일 μ̂가 음수)면 "통계적 우위 없음" → 5% 소형 포지션까지만
    if (p.kelly !== null) w = Math.min(w, p.kelly > 0 ? p.kelly * 100 : 5);
    w = Math.min(w, DEFAULT_GATE.maxWeightPct);
    if (w >= 1) draft.targets.push({ market: p.market, weightPct: +w.toFixed(1), why: `${p.why}; σ ${p.sigma}%/d, kelly½ ${p.kelly ?? "n/a"}${p.kelly !== null && p.kelly <= 0 ? " (no statistical edge → capped 5%)" : ""}` });
  });
  draft.grossPct = +draft.targets.reduce((a, t) => a + t.weightPct, 0).toFixed(1);
  const rejected = scored.filter((s) => !picks.includes(s)).map((s) => `${s.market} excluded (score ${s.score}${s.sigma === null ? ", no σ" : ""}: ${s.why || "no upstream data"})`);
  const quantOk = sigma.size > 0 && /HMM regime belief/.test(quantText);
  mark(quant, quantOk ? "Completed" : "❌", quantMs, quantOk ? `${draft.targets.length} targets, gross ${draft.grossPct}%` : "quant report lacks fitted model — not accepted");
  let quantSection = `${head(quant)}\n\n${quantText}\n\n### Model view (from the four desks above + this report)\n${scored.map((s) => `  ${s.market}: score ${s.score >= 0 ? "+" : ""}${s.score} — ${s.why || "no upstream data"}`).join("\n")}\n\n${fmtDraft(draft)}${rejected.length ? `\n${rejected.map((r) => `  ${r}`).join("\n")}` : ""}`;

  // ── 3) 리스크 오피서 — 퀀트 검토 (REVISE 라운드) ────────────────────────────────
  const risk = role("risk-officer"); start(risk);
  let riskText = "", riskMs = 0, riskVerdict: "APPROVE" | "REVISE" | "NONE" = "NONE";
  const riskLog: string[] = [];
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    const basket = draft.targets.map((t) => sym(t.market));
    if (basket.length < 2) { riskVerdict = "APPROVE"; riskLog.push(`round ${round}: ${basket.length} position(s) — correlation review not applicable, APPROVE`); break; }
    try { const r = await tool(risk, basket.join(" ")); toolCalls++; riskText = r.text; riskMs += r.ms; } catch (e) { riskText = `(tool failed: ${(e as Error).message})`; break; }
    const { avgCorr } = parseRisk(riskText);
    const var95 = riskText.match(/inverse-vol weights[^\n]*VaR95 ([\d.]+)%/)?.[1];
    if (avgCorr === null) { riskLog.push(`round ${round}: no correlation matrix in report — cannot review`); break; }
    if (avgCorr > 0.75 && draft.grossPct > 50) {
      rounds++; riskVerdict = "REVISE";
      riskLog.push(`round ${round}: REVISE — avg pairwise corr ${avgCorr} (one bet), gross ${draft.grossPct}% > 50% → cut gross to 50%`);
      const k = 50 / draft.grossPct; draft.version++; for (const t of draft.targets) t.weightPct = +(t.weightPct * k).toFixed(1); draft.grossPct = +draft.targets.reduce((a, t) => a + t.weightPct, 0).toFixed(1);
      draft.notes.push(`v${draft.version}: risk officer round ${round} — corr ${avgCorr}, gross scaled ×${k.toFixed(2)}`);
      quantSection += `\n\n### Revision v${draft.version} (after Risk review round ${round})\n${fmtDraft(draft)}`;
      continue;
    }
    if (var95 && Number(var95) > 6 && draft.grossPct > 60) {
      rounds++; riskVerdict = "REVISE";
      riskLog.push(`round ${round}: REVISE — inverse-vol basket VaR95 ${var95}%/d > 6%, gross ${draft.grossPct}% → cut to 60%`);
      const k = 60 / draft.grossPct; draft.version++; for (const t of draft.targets) t.weightPct = +(t.weightPct * k).toFixed(1); draft.grossPct = +draft.targets.reduce((a, t) => a + t.weightPct, 0).toFixed(1);
      quantSection += `\n\n### Revision v${draft.version} (after Risk review round ${round})\n${fmtDraft(draft)}`;
      continue;
    }
    riskVerdict = "APPROVE"; riskLog.push(`round ${round}: APPROVE — avg corr ${avgCorr}${var95 ? `, VaR95 ${var95}%/d` : ""}, gross ${draft.grossPct}%`); break;
  }
  if (riskVerdict === "REVISE") riskLog.push(`review rounds exhausted (${MAX_REVIEW_ROUNDS}) — last revision stands, flagged`);
  mark(risk, riskVerdict === "NONE" ? "❌" : "Completed", riskMs, riskLog[riskLog.length - 1] ?? "no verdict");
  sections.push(quantSection);
  sections.push(`${head(risk)}\n\n${riskText}\n\n### Verdict: ${riskVerdict === "NONE" ? "NO VERDICT" : riskVerdict}\n${riskLog.map((l) => `  ${l}`).join("\n")}`);

  // ── 4) 리밸런스 플래너 — 퀀트(최종본) + 리스크 + 자기 도구(워커의 블렌디드 알파) ────
  const planner = role("rebalance-planner"); start(planner);
  let planText = "", planMs = 0;
  try { const r = await tool(planner, q); toolCalls++; planText = r.text; planMs = r.ms; } catch (e) { planText = `(tool failed: ${(e as Error).message})`; }
  const workerTargets = new Map<string, number>();
  for (const m of planText.matchAll(/^\s*(KRW-[A-Z0-9]+): target ([\d.]+)%/gm)) workerTargets.set(m[1], Number(m[2]));
  // 50/50 혼합: 퀀트 데스크의 모델 뷰 + 워커의 블렌디드 알파. 둘 다 실데이터에서 나온 숫자
  const plan = new Map<string, number>();
  for (const t of draft.targets) plan.set(t.market, t.weightPct * 0.5);
  for (const [m, w] of workerTargets) if (markets.includes(m)) plan.set(m, (plan.get(m) ?? 0) + w * 0.5);
  let planRows = [...plan].filter(([, w]) => w >= 1).map(([market, w]) => ({ market, weightPct: +Math.min(DEFAULT_GATE.maxWeightPct, w).toFixed(1) })).sort((a, b) => b.weightPct - a.weightPct).slice(0, DEFAULT_GATE.maxPositions);
  const table = (rows: typeof planRows) => [`| # | market | action | target |`, `|---|---|---|---|`, ...rows.map((r, i) => `| ${i + 1} | ${r.market} | BUY to target | ${r.weightPct}% |`), `| ${rows.length + 1} | cash | hold | ${(100 - rows.reduce((a, r) => a + r.weightPct, 0)).toFixed(1)}% |`].join("\n");
  const planOk = planRows.length > 0 || (draft.targets.length === 0 && workerTargets.size === 0);
  let planSection = `${head(planner)}\n\n${planText}\n\n### Rebalance proposal v1 (50% quant desk v${draft.version} + 50% worker blended alpha, cap ${DEFAULT_GATE.maxWeightPct}%, max ${DEFAULT_GATE.maxPositions})\n${table(planRows)}`;
  mark(planner, planOk ? "Completed" : "❌", planMs, planOk ? `${planRows.length} positions, gross ${planRows.reduce((a, r) => a + r.weightPct, 0).toFixed(1)}%` : "no targets from either source");

  // ── 5) 레드팀 — 플래너 검토 (백테스트로 반박, REVISE 라운드) ──────────────────────
  const red = role("red-team"); start(red);
  let redMs = 0, redVerdict: "APPROVE" | "REVISE" | "NONE" = "NONE";
  const redLog: string[] = [];
  const redTexts: string[] = [];
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    const top = planRows.slice(0, 3);
    if (top.length === 0) { redVerdict = "APPROVE"; redLog.push(`round ${round}: nothing to challenge — proposal is cash, APPROVE`); break; }
    const weak: string[] = [];
    for (const t of top) {
      try {
        const r = await tool(red, `${sym(t.market)} momentum-20`); toolCalls++; redMs += r.ms; redTexts.push(r.text);
        const m = r.text.match(/momentum-20\]: annual=([\d.-]+)% \(B&H ([\d.-]+)%\) sharpe=([\d.-]+)/);
        if (m && Number(m[3]) < 0 && Number(m[1]) < Number(m[2]) - 10) weak.push(`${t.market} (momentum-20 annual ${m[1]}% vs B&H ${m[2]}%, sharpe ${m[3]})`);
      } catch (e) { redTexts.push(`(tool failed for ${t.market}: ${(e as Error).message})`); }
    }
    if (weak.length && round < MAX_REVIEW_ROUNDS + 1) {
      rounds++; redVerdict = "REVISE";
      redLog.push(`round ${round}: REVISE — trend signal has no edge on ${weak.join("; ")} → halve those weights`);
      planRows = planRows.map((r) => (weak.some((w) => w.startsWith(r.market)) ? { ...r, weightPct: +(r.weightPct / 2).toFixed(1) } : r)).filter((r) => r.weightPct >= 1);
      planSection += `\n\n### Revision v${round + 1} (after Red-team round ${round})\n${table(planRows)}`;
      if (round === MAX_REVIEW_ROUNDS) { redLog.push(`review rounds exhausted (${MAX_REVIEW_ROUNDS}) — halved weights stand, flagged`); }
      continue;
    }
    redVerdict = "APPROVE"; redLog.push(`round ${round}: APPROVE — no challenged position lacks a backtested edge`); break;
  }
  mark(red, redVerdict === "NONE" ? "❌" : "Completed", redMs, redLog[redLog.length - 1] ?? "no verdict");
  sections.push(planSection);
  sections.push(`${head(red)}\n\n${redTexts.join("\n\n")}\n\n### Verdict: ${redVerdict === "NONE" ? "NO VERDICT" : redVerdict}\n${redLog.map((l) => `  ${l}`).join("\n")}`);

  // ── 6) 위원장 — 전부 읽고 결정 JSON ───────────────────────────────────────────
  const chair = role("chair"); start(chair);
  const final = planRows.map((r) => ({ market: r.market, weightPct: r.weightPct }));
  const gross = +final.reduce((a, t) => a + t.weightPct, 0).toFixed(1);
  const failedSteps = steps.filter((s) => s.status !== "Completed").map((s) => s.name);
  const chairLines = [
    `Committee read: ${markets.length} markets scoped; chart/news/flow/macro desks ${analysts.filter((id) => steps.find((s) => s.role === id)?.status === "Completed").length}/4 accepted; quant draft v${draft.version}; risk verdict ${riskVerdict}; red-team verdict ${redVerdict}; ${rounds} revision round(s).`,
    failedSteps.length ? `Steps not accepted: ${failedSteps.join(", ")} — decision still recorded, but the gate (loop.ts) will not execute it.` : `All ${steps.length} steps accepted.`,
    `Decision: ${final.length ? final.map((t) => `${sym(t.market)} ${t.weightPct}%`).join(", ") : "no positions"} · gross ${gross}% · cash ${(100 - gross).toFixed(1)}%.`,
    "",
    "```json",
    JSON.stringify({ targets: markets.map((m) => ({ market: m, weightPct: final.find((t) => t.market === m)?.weightPct ?? 0 })), cashPct: +(100 - gross).toFixed(1) }),
    "```",
  ];
  mark(chair, "Completed", 0, `${final.length} positions, gross ${gross}%`);
  sections.push(`${head(chair)}\n\n${chairLines.join("\n")}`);

  const accepted = steps.filter((s) => s.status === "Completed").length;
  const headline = `${accepted}/${steps.length} steps accepted · ${rounds} revision round(s) · ${toolCalls} tool calls · local (no escrow)`;
  logger.info("[office:local] deliberation done", { accepted, steps: steps.length, rounds, toolCalls });
  return { output: sections.join("\n\n"), steps, rounds, headline, toolCalls };
}

export function localMode(): boolean { return config.OFFICE_MODE === "local"; }
