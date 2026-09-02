import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { officeLoop } from "../office/loop.js";
import { scoreHeadline } from "../sentiment/scorer.js";
import { DESK_GENES, type Genes } from "./genome.js";

/**
 * 에이전트 = 오피스. 개체는 숫자 전략만 돌리는 게 아니라 **실제 MCP 데스크를 빌려**
 * 보고서를 읽고, 스킬(보고서를 타깃에 반영하는 규칙)로 자기 포트폴리오를 고친다.
 *
 * - 데스크 = 실 MCP 서버의 툴 하나 (우리 Vercel 워커 5개 + Exa 웹 검색). 호출은 진짜고,
 *   세대마다 **임대료**가 자본에서 빠진다. 눈이 많은 개체는 비싸다 — 벌어서 갚아야 산다.
 * - 스킬 = 보고서 텍스트 → 타깃 변경 규칙. 전부 결정적이고 파싱 실패는 "적용 안 함"이다.
 *   보고서에 없는 숫자를 만들어 내는 곳은 없다.
 * - 같은 세대의 같은 질의는 한 번만 부른다(공유 데스크). 개체 24개가 뉴스 데스크를 켜도
 *   호출은 1회, 임대료는 24번 — 오피스가 데스크를 나눠 쓰는 것과 같다.
 * - Handsel 오피스 결정(채점 통과한 위원장 JSON)은 `office` 데스크로 읽는다 — 토큰과
 *   run이 있을 때만. 없으면 그 스킬은 조용히 비활성.
 *
 * 돈 경계: 여기서는 자본(페이퍼)만 움직인다. 실주문 경로 없음.
 */

export type DeskId = (typeof DESK_GENES)[number];

export interface DeskSpec {
  id: DeskId;
  label: string;
  labelKo: string;
  /** MCP 서버 URL ("worker" = OFFICE_WORKER_URL) */
  server: "worker" | string;
  tool: string;
  argKey: string;
  /** 세대당 임대료 — 자본 대비 비율 (0.002 = 0.2%) */
  rentPct: number;
  skill: string;
}

export const DESKS: DeskSpec[] = [
  { id: "deskChart", label: "Chart desk", labelKo: "차트 데스크", server: "worker", tool: "upbit_market_report", argKey: "query", rentPct: 0.0015, skill: "MA20 아래(downtrend bias)이거나 P(bear)>P(bull)인 종목은 제외" },
  { id: "deskNews", label: "News desk", labelKo: "뉴스 데스크", server: "worker", tool: "upbit_news_report", argKey: "query", rentPct: 0.002, skill: "aggregate BEARISH 종목 거부, 그 외 감성 점수만큼 비중 기울기" },
  { id: "deskFlow", label: "Flow desk", labelKo: "수급 데스크", server: "worker", tool: "upbit_flow_report", argKey: "query", rentPct: 0.0015, skill: "호가 불균형·테이커 매수 비중으로 비중 기울기" },
  { id: "deskMacro", label: "Macro desk", labelKo: "매크로 데스크", server: "worker", tool: "macro_report", argKey: "query", rentPct: 0.001, skill: "risk-off면 총노출 축소, risk-on이면 유지" },
  { id: "deskRisk", label: "Risk desk", labelKo: "리스크 데스크", server: "worker", tool: "basket_risk_report", argKey: "query", rentPct: 0.0015, skill: "평균 쌍상관이 높으면(한 베팅) 총노출 축소" },
  { id: "deskWeb", label: "Web search desk", labelKo: "웹 검색 데스크", server: "https://mcp.exa.ai/mcp", tool: "web_search_exa", argKey: "query", rentPct: 0.0025, skill: "검색 결과 제목을 우리 렉시콘으로 채점 — 뉴스 데스크의 2차 의견" },
];
export const OFFICE_RENT_PCT = 0.003;

export interface DeskReading {
  desk: DeskId | "office";
  ok: boolean;
  summary: string;
  ms: number;
}

// ── MCP 호출 (Streamable HTTP JSON-RPC, 무상태) ───────────────────────────────
export async function mcpCall(server: string, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
  const url = server === "worker" ? config.OFFICE_WORKER_URL : server;
  // 워커는 공개 읽기 전용(Handsel 오피스도 토큰 없이 부른다); Exa도 공개 엔드포인트
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${tool} HTTP ${res.status}: ${text.slice(0, 160)}`);
  // SSE 응답이면 data: 줄만 모은다
  const payload = text.trimStart().startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? ""
    : text;
  const body = JSON.parse(payload) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: { message: string } };
  if (body.error) throw new Error(`${tool}: ${body.error.message}`);
  const out = (body.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  if (body.result?.isError) throw new Error(`${tool} isError: ${out.slice(0, 160)}`);
  return out;
}

// ── 세대 공유 캐시 (같은 질의는 한 번) ───────────────────────────────────────────
const cache = new Map<string, Promise<{ text: string; ms: number }>>();
let cacheGen = -1;
export function resetDeskCache(gen: number) { if (gen !== cacheGen) { cache.clear(); cacheGen = gen; } }

async function readDesk(desk: DeskSpec, query: string): Promise<{ text: string; ms: number }> {
  const key = `${desk.id}|${query}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const text = await mcpCall(desk.server, desk.tool, { [desk.argKey]: query });
      return { text, ms: Date.now() - t0 };
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

// ── 보고서 파서 (순수) ───────────────────────────────────────────────────────────
export interface ChartRead { market: string; above: boolean | null; pBull: number | null; pBear: number | null; regime: string | null }
export function parseChart(text: string): ChartRead[] {
  const out: ChartRead[] = [];
  for (const sec of text.split(/\n(?=## )/)) {
    const m = sec.match(/^## (KRW-[A-Z0-9]+)/); if (!m) continue;
    if (/no data \(skipped/.test(sec)) continue;
    const above = /is ABOVE MA20/.test(sec) ? true : /is BELOW MA20/.test(sec) ? false : null;
    const pb = sec.match(/P\(bull\)=([\d.]+)/), pr = sec.match(/P\(bear\)=([\d.]+)/), lb = sec.match(/P\(bear\)=[\d.n/a]+ \[([^\]]+)\]/);
    out.push({ market: m[1], above, pBull: pb ? Number(pb[1]) : null, pBear: pr ? Number(pr[1]) : null, regime: lb ? lb[1] : null });
  }
  return out;
}
export interface NewsRead { market: string; label: "BULLISH" | "BEARISH" | "NEUTRAL"; score: number; headlines: number }
export function parseNews(text: string): NewsRead[] {
  const out: NewsRead[] = [];
  for (const sec of text.split(/\n(?=## )/)) {
    const m = sec.match(/^## (KRW-[A-Z0-9]+) — (\d+) headlines, aggregate (BULLISH|BEARISH|NEUTRAL) ([+-][\d.]+)/);
    if (m) out.push({ market: m[1], headlines: Number(m[2]), label: m[3] as NewsRead["label"], score: Number(m[4]) });
  }
  return out;
}
export interface FlowRead { market: string; imbalance: number | null; buyShare: number | null }
export function parseFlow(text: string): FlowRead[] {
  const out: FlowRead[] = [];
  for (const sec of text.split(/\n(?=## )/)) {
    const m = sec.match(/^## (KRW-[A-Z0-9]+)/); if (!m || /no order-book/.test(sec)) continue;
    const im = sec.match(/imbalance ([+-]?[\d.]+)%/), bs = sec.match(/buy share ([\d.]+)%/);
    out.push({ market: m[1], imbalance: im ? Number(im[1]) / 100 : null, buyShare: bs ? Number(bs[1]) / 100 : null });
  }
  return out;
}
export type MacroRead = "risk-on" | "risk-off" | "mixed" | "undetermined";
export function parseMacro(text: string): MacroRead {
  const m = text.match(/read: (risk-on|risk-off|mixed|undetermined)/);
  return (m?.[1] as MacroRead) ?? "undetermined";
}
export function parseRisk(text: string): { avgCorr: number | null } {
  const m = text.match(/average pairwise correlation ([\d.-]+)/);
  return { avgCorr: m ? Number(m[1]) : null };
}
/** Exa 결과의 제목 줄들을 우리 렉시콘(scoreHeadline)으로 채점 — 코인별 평균 */
export function scoreWebTitles(text: string, coins: string[]): Array<{ market: string; score: number; n: number }> {
  const lines = text.split("\n").map((l) => l.replace(/^[-*#\d.)\s]+/, "").trim()).filter((l) => l.length > 12 && l.length < 200 && !/^https?:\/\//.test(l));
  return coins.map((c) => {
    const rel = lines.filter((l) => new RegExp(`\\b${c}\\b`, "i").test(l));
    const scores = rel.map((l) => scoreHeadline(l).score);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    return { market: `KRW-${c}`, score: +avg.toFixed(3), n: scores.length };
  }).filter((r) => r.n > 0);
}

// ── 스킬 적용 (순수) ─────────────────────────────────────────────────────────────
export interface Target { market: string; weightPct: number }
export interface OverlayInput {
  chart?: ChartRead[]; news?: NewsRead[]; flow?: FlowRead[]; macro?: MacroRead; risk?: { avgCorr: number | null }; web?: Array<{ market: string; score: number; n: number }>;
  office?: Target[] | null;
}
export interface OverlayResult { targets: Target[]; notes: string[] }

export function applySkills(base: Target[], trust: number, r: OverlayInput): OverlayResult {
  const t = Math.max(0, Math.min(1, trust));
  const notes: string[] = [];
  let targets = base.map((x) => ({ ...x }));
  const sym = (m: string) => m.replace("KRW-", "");
  if (r.chart) {
    // 하락 추세(MA20 아래)이거나 워커 HMM이 이 종목을 명시적으로 bear 국면이라 라벨했을 때만 제외.
    // (P(bull)=0 만으로는 안 자른다 — 3상태 HMM은 중립 국면에서 P(bull)이 0이어도 상승 추세일 수 있다)
    const drop = new Set(r.chart.filter((c) => c.above === false || (c.regime !== null && /bear|약세/i.test(c.regime) && (c.pBear ?? 0) > (c.pBull ?? 0))).map((c) => c.market));
    const before = targets.length; targets = targets.filter((x) => !(drop.has(x.market) && t >= 0.34));
    if (before !== targets.length) notes.push(`chart: dropped ${[...drop].filter((m) => base.some((b) => b.market === m)).map(sym).join(",")} (below MA20 / bear regime)`);
    else if (r.chart.length) notes.push(`chart: ${r.chart.map((c) => `${sym(c.market)} ${c.above === null ? "?" : c.above ? "above" : "below"} MA20${c.regime ? ` [${c.regime}]` : ""}`).join(", ")} — kept`);
  }
  if (r.news) {
    const bear = new Set(r.news.filter((n) => n.label === "BEARISH").map((n) => n.market));
    const before = targets.length; targets = targets.filter((x) => !(bear.has(x.market) && t >= 0.34));
    if (before !== targets.length) notes.push(`news: vetoed ${[...bear].filter((m) => base.some((b) => b.market === m)).map(sym).join(",")} (BEARISH headlines)`);
    for (const x of targets) { const n = r.news.find((y) => y.market === x.market); if (n && n.label !== "BEARISH") x.weightPct *= 1 + t * Math.max(-0.5, Math.min(0.5, n.score)); }
  }
  if (r.web) {
    for (const x of targets) { const w = r.web.find((y) => y.market === x.market); if (w) { x.weightPct *= 1 + 0.5 * t * Math.max(-0.5, Math.min(0.5, w.score)); } }
    if (r.web.length) notes.push(`web: ${r.web.map((w) => `${sym(w.market)} ${w.score >= 0 ? "+" : ""}${w.score}(${w.n})`).join(" ")}`);
  }
  if (r.flow) {
    for (const x of targets) { const f = r.flow.find((y) => y.market === x.market); if (!f) continue; const tilt = (f.imbalance ?? 0) * 0.5 + ((f.buyShare ?? 0.5) - 0.5); x.weightPct *= 1 + t * Math.max(-0.4, Math.min(0.4, tilt)); }
    notes.push(`flow: tilted by book imbalance / taker buy share (trust ${t.toFixed(2)})`);
  }
  let scale = 1;
  if (r.macro === "risk-off") { scale *= 1 - 0.5 * t; notes.push(`macro: risk-off → exposure ×${(1 - 0.5 * t).toFixed(2)}`); }
  else if (r.macro === "mixed") { scale *= 1 - 0.2 * t; notes.push(`macro: mixed → exposure ×${(1 - 0.2 * t).toFixed(2)}`); }
  else if (r.macro === "risk-on") notes.push("macro: risk-on → exposure kept");
  if (r.risk?.avgCorr !== undefined && r.risk.avgCorr !== null) {
    if (r.risk.avgCorr > 0.75) { scale *= 1 - 0.4 * t; notes.push(`risk: avg corr ${r.risk.avgCorr} — one bet → exposure ×${(1 - 0.4 * t).toFixed(2)}`); }
    else if (r.risk.avgCorr > 0.5) { scale *= 1 - 0.15 * t; notes.push(`risk: avg corr ${r.risk.avgCorr} → exposure ×${(1 - 0.15 * t).toFixed(2)}`); }
    else notes.push(`risk: avg corr ${r.risk.avgCorr} — diversified`);
  }
  if (r.office && r.office.length) {
    // 위원장 결정 쪽으로 t만큼 당긴다 (실제 채점 통과 결정만 여기 들어온다)
    const m = new Map<string, number>();
    for (const x of targets) m.set(x.market, (m.get(x.market) ?? 0) + x.weightPct * (1 - t));
    for (const o of r.office) m.set(o.market, (m.get(o.market) ?? 0) + o.weightPct * t);
    targets = [...m].map(([market, weightPct]) => ({ market, weightPct }));
    notes.push(`office: blended ${(t * 100).toFixed(0)}% toward the committee decision (${r.office.map((o) => sym(o.market)).join(",")})`);
  }
  const gross0 = base.reduce((a, x) => a + x.weightPct, 0);
  let gross = targets.reduce((a, x) => a + x.weightPct, 0);
  if (gross > gross0 && gross > 0) { for (const x of targets) x.weightPct *= gross0 / gross; gross = gross0; } // 기울기가 노출을 늘리진 못한다
  for (const x of targets) x.weightPct = +(x.weightPct * scale).toFixed(2);
  targets = targets.filter((x) => x.weightPct >= 0.5);
  return { targets, notes };
}

// ── 데스크 실행 (세대마다, 개체가 켠 데스크만) ───────────────────────────────────
export interface DeskSession {
  readings: DeskReading[];
  input: OverlayInput;
}

function coinsOf(targets: Target[]): string[] { return [...new Set(targets.map((t) => t.market.replace("KRW-", "")))]; }

/** 개체 하나가 켠 데스크들을 (공유 캐시를 통해) 읽는다. 실패한 데스크는 읽기 실패로 기록되고 스킬은 건너뛴다 */
export async function consultDesks(genes: Genes, base: Target[], universe: string[]): Promise<DeskSession> {
  const readings: DeskReading[] = [];
  const input: OverlayInput = {};
  const coins = coinsOf(base);
  // 베이스가 비어(현금) 있어도 유니버스 상위 코인으로 시장 읽기는 한다 — 매크로/리스크가 다음 리밸런스에 쓰인다
  const q = (coins.length ? coins : universe.slice(0, 5)).join(" ");
  const on = new Set(DESK_GENES.filter((k) => genes[k] >= 1));
  const run = async (desk: DeskSpec, query: string, apply: (text: string) => string) => {
    const t0 = Date.now();
    try { const r = await readDesk(desk, query); readings.push({ desk: desk.id, ok: true, summary: apply(r.text), ms: r.ms }); }
    catch (e) { readings.push({ desk: desk.id, ok: false, summary: (e as Error).message.slice(0, 120), ms: Date.now() - t0 }); }
  };
  const jobs: Promise<void>[] = [];
  for (const desk of DESKS) {
    if (!on.has(desk.id)) continue;
    switch (desk.id) {
      case "deskChart": jobs.push(run(desk, q, (t) => { input.chart = parseChart(t); return input.chart.map((c) => `${c.market.replace("KRW-", "")}:${c.above === null ? "?" : c.above ? "↑" : "↓"}${c.regime ? ` ${c.regime}` : ""}`).join(" ") || "no coins parsed"; })); break;
      case "deskNews": jobs.push(run(desk, q, (t) => { input.news = parseNews(t); return input.news.map((n) => `${n.market.replace("KRW-", "")}:${n.label} ${n.score >= 0 ? "+" : ""}${n.score}(${n.headlines})`).join(" ") || "no headlines"; })); break;
      case "deskFlow": jobs.push(run(desk, q, (t) => { input.flow = parseFlow(t); return input.flow.map((f) => `${f.market.replace("KRW-", "")}:imb ${f.imbalance === null ? "?" : (f.imbalance * 100).toFixed(0) + "%"} buy ${f.buyShare === null ? "?" : (f.buyShare * 100).toFixed(0) + "%"}`).join(" ") || "no book"; })); break;
      case "deskMacro": jobs.push(run(desk, "crypto risk read", (t) => { input.macro = parseMacro(t); return input.macro; })); break;
      case "deskRisk": jobs.push(run(desk, q, (t) => { input.risk = parseRisk(t); return input.risk.avgCorr === null ? "no matrix" : `avg corr ${input.risk.avgCorr}`; })); break;
      case "deskWeb": jobs.push(run(desk, `${coins.length ? coins.join(" ") : universe.slice(0, 3).join(" ")} crypto news today`, (t) => { input.web = scoreWebTitles(t, coins.length ? coins : universe.slice(0, 3)); return input.web.map((w) => `${w.market.replace("KRW-", "")} ${w.score >= 0 ? "+" : ""}${w.score}(${w.n})`).join(" ") || "no relevant titles"; })); break;
    }
  }
  await Promise.all(jobs);
  return { readings, input };
}

/** Handsel 오피스의 마지막 채점 통과 결정 — 있을 때만 (없으면 null, 스킬 비활성) */
export function latestOfficeDecision(): { targets: Target[]; delegationId: string; decidedAt: string } | null {
  try {
    for (const run of officeLoop.list()) {
      const d = run.decision;
      if (d && d.allPassed && d.executable && d.targets.length) return { targets: d.targets.map((t) => ({ market: t.market, weightPct: t.weightPct })), delegationId: d.delegationId, decidedAt: d.decidedAt };
    }
  } catch (e) { logger.warn("[evolution] office decision read failed", { error: (e as Error).message }); }
  return null;
}

/** 세대 임대료 — 켠 데스크의 rentPct 합 × 자본 (+ 오피스 결정을 쓰면 OFFICE_RENT_PCT) */
export function rentFor(genes: Genes, capitalKrw: number, usesOffice: boolean): { krw: number; pct: number; desks: DeskId[] } {
  const desks = DESK_GENES.filter((k) => genes[k] >= 1);
  const pct = desks.reduce((a, k) => a + (DESKS.find((d) => d.id === k)?.rentPct ?? 0), 0) + (usesOffice ? OFFICE_RENT_PCT : 0);
  return { krw: Math.round(capitalKrw * pct), pct, desks };
}
