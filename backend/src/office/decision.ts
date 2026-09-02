/**
 * 오피스 결정 — 순수 함수. Handsel 오피스(차트·뉴스·퀀트·리밸런스 4 역할)의
 * 대화 산출물(마크다운)을 (1) conversation.md 로 그대로 보존하고
 * (2) decision.json 으로 구조화하고 (3) 실행 가능 여부를 판정한다.
 *
 * 원칙:
 *  - 대화 원문은 손대지 않는다. 결정은 원문에서 "인용"될 뿐 재작성되지 않는다.
 *  - 채점을 통과(Completed)하지 못한 단계가 하나라도 있으면 결정은 무효다 —
 *    Handsel의 pay-only-on-pass 가 곧 매매 QA 관문이다.
 *  - 파싱 실패는 "결정 없음"이지 "현금 100%"가 아니다. 지어내지 않는다.
 */

export interface DecisionTarget {
  market: string; // KRW-XXX
  weightPct: number;
}

export interface DecisionRecord {
  delegationId: string;
  decidedAt: string;
  /** 결정 소스 — 최종 산출물 안의 JSON 블록이었는지, 표/문장 파싱이었는지 */
  source: "json-block" | "table" | "lines";
  targets: DecisionTarget[];
  cashPct: number;
  /** 단계별 판정 (delegation_status 텍스트에서 추출) */
  steps: Array<{ name: string; status: string }>;
  allPassed: boolean;
  /** 실행 가능 여부와 사유 — 관문을 통과하지 못하면 executable=false */
  executable: boolean;
  reasons: string[];
  /** 대화 속 역할별 요약 (섹션 제목 기준 첫 문장) */
  roles: Array<{ role: string; excerpt: string }>;
}

export interface DecisionGate {
  maxWeightPct: number;
  maxPositions: number;
  allowedMarkets?: Set<string>;
}

export const DEFAULT_GATE: DecisionGate = { maxWeightPct: 40, maxPositions: 8 };

const ROLE_HEADERS = ["Chart analysis", "News & filings analysis", "Quant model", "Rebalance proposal"];

/** delegation_status 텍스트에서 한 딜리게이션의 단계 상태를 뽑는다 */
export function parseSteps(statusText: string, delegationId: string): Array<{ name: string; status: string }> {
  const lines = statusText.split("\n");
  const start = lines.findIndex((l) => l.startsWith(delegationId));
  if (start < 0) return [];
  const out: Array<{ name: string; status: string }> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^dlg-/.test(l)) break; // 다음 딜리게이션
    const m = /^\s+-\s+(❌|…|Completed|Submitted|Claimed|Expired|Open|Posted)\s+(.+?)(?:\s+\(\$[\d.]+\).*)?$/.exec(l);
    if (!m) continue;
    const name = m[2].split(" — ")[0].trim();
    out.push({ name, status: m[1] });
  }
  return out;
}

export function delegationHeadline(statusText: string, delegationId: string): string | null {
  const l = statusText.split("\n").find((x) => x.startsWith(delegationId));
  return l ? l.trim() : null;
}

/** 최종 산출물에서 역할별 발췌 (대화 요약용) */
export function roleExcerpts(output: string): Array<{ role: string; excerpt: string }> {
  const out: Array<{ role: string; excerpt: string }> = [];
  for (const role of ROLE_HEADERS) {
    const idx = output.indexOf(`## ${role}`);
    if (idx < 0) continue;
    const body = output.slice(idx).split("\n").slice(1).join("\n");
    const first = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith("|") && !l.startsWith("**Data") && !l.startsWith(">"))
      .slice(0, 2)
      .join(" ");
    out.push({ role, excerpt: first.slice(0, 280) });
  }
  return out;
}

/** 산출물에서 타깃 비중을 뽑는다 — JSON 블록 > 주문표 > 문장 순으로 시도 */
export function extractTargets(output: string): { source: DecisionRecord["source"]; targets: DecisionTarget[]; cashPct: number } | null {
  // 1) ```json { "targets": [...], "cashPct": n } ```
  const blocks = [...output.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks.reverse()) {
    try {
      const j = JSON.parse(b) as { targets?: Array<{ market?: string; weightPct?: number }>; cashPct?: number };
      if (Array.isArray(j.targets)) {
        const targets = j.targets
          .filter((t) => typeof t.market === "string" && typeof t.weightPct === "number")
          .map((t) => ({ market: String(t.market).toUpperCase(), weightPct: +Number(t.weightPct).toFixed(1) }));
        if (targets.length) {
          const alloc = targets.reduce((a, t) => a + t.weightPct, 0);
          return { source: "json-block", targets, cashPct: typeof j.cashPct === "number" ? j.cashPct : +(100 - alloc).toFixed(1) };
        }
      }
    } catch {
      /* 다음 블록 */
    }
  }
  // 2) 리밸런스 주문표: | # | KRW-ETH | BUY to target | 40% | ...
  const rows = [...output.matchAll(/\|\s*\d+\s*\|\s*(KRW-[A-Z0-9]+)\s*\|[^|]*\|\s*(\d+(?:\.\d+)?)%\s*\|/g)];
  if (rows.length) {
    const targets = rows.map((m) => ({ market: m[1], weightPct: +Number(m[2]).toFixed(1) })).filter((t) => t.weightPct > 0);
    const alloc = targets.reduce((a, t) => a + t.weightPct, 0);
    return { source: "table", targets, cashPct: +(100 - alloc).toFixed(1) };
  }
  // 3) 문장: "KRW-ETH: target 40.0%" / "KRW-ETH — 40%"
  const lines = [...output.matchAll(/(KRW-[A-Z0-9]+)\s*[:—-]+\s*(?:target\s*)?(\d+(?:\.\d+)?)\s*%/gi)];
  if (lines.length) {
    const seen = new Map<string, number>();
    for (const m of lines) if (!seen.has(m[1].toUpperCase())) seen.set(m[1].toUpperCase(), +Number(m[2]).toFixed(1));
    const targets = [...seen].map(([market, weightPct]) => ({ market, weightPct })).filter((t) => t.weightPct > 0);
    const alloc = targets.reduce((a, t) => a + t.weightPct, 0);
    return { source: "lines", targets, cashPct: +(100 - alloc).toFixed(1) };
  }
  return null;
}

/** 결정 레코드 조립 + 관문 판정 */
export function buildDecision(p: {
  delegationId: string;
  output: string;
  statusText: string;
  gate?: DecisionGate;
  /** 오피스 단계 수 — 전부 Completed여야 결정이 유효하다 (기본 4 = 구 securities-desk) */
  expectedSteps?: number;
  now?: Date;
}): DecisionRecord {
  const gate = p.gate ?? DEFAULT_GATE;
  const steps = parseSteps(p.statusText, p.delegationId);
  const reasons: string[] = [];
  const expected = p.expectedSteps ?? 4;
  const allPassed = steps.length >= expected && steps.every((s) => s.status === "Completed");
  if (steps.length < expected) reasons.push(`단계 ${steps.length}/${expected} 만 확인됨`);
  const failed = steps.filter((s) => s.status !== "Completed");
  if (failed.length) reasons.push(`채점 미통과/미완 단계: ${failed.map((s) => `${s.name}(${s.status})`).join(", ")}`);

  const ext = extractTargets(p.output);
  let targets: DecisionTarget[] = [];
  let cashPct = 100;
  if (!ext) reasons.push("산출물에서 타깃 비중을 추출하지 못함 — 결정 없음 (현금 100%로 대체하지 않음)");
  else {
    targets = ext.targets;
    cashPct = ext.cashPct;
    const bad = targets.filter((t) => !/^KRW-[A-Z0-9]+$/.test(t.market));
    if (bad.length) reasons.push(`KRW 마켓이 아닌 타깃: ${bad.map((b) => b.market).join(", ")}`);
    if (gate.allowedMarkets) {
      const outside = targets.filter((t) => !gate.allowedMarkets!.has(t.market));
      if (outside.length) reasons.push(`스코프 밖 마켓: ${outside.map((b) => b.market).join(", ")}`);
    }
    const over = targets.filter((t) => t.weightPct > gate.maxWeightPct);
    if (over.length) reasons.push(`코인당 상한 ${gate.maxWeightPct}% 초과: ${over.map((o) => `${o.market} ${o.weightPct}%`).join(", ")}`);
    const alloc = targets.reduce((a, t) => a + t.weightPct, 0);
    if (alloc > 100.5) reasons.push(`비중 합 ${alloc.toFixed(1)}% > 100%`);
    if (targets.length > gate.maxPositions) reasons.push(`포지션 수 ${targets.length} > ${gate.maxPositions}`);
  }

  return {
    delegationId: p.delegationId,
    decidedAt: (p.now ?? new Date()).toISOString(),
    source: ext?.source ?? "lines",
    targets,
    cashPct,
    steps,
    allPassed,
    executable: allPassed && ext !== null && reasons.length === 0,
    reasons,
    roles: roleExcerpts(p.output),
  };
}

/** conversation.md — 대화 원문 + 머리말(누가·언제·어떤 판정). 원문은 그대로. */
export function renderConversation(p: { delegationId: string; headline: string | null; decision: DecisionRecord; output: string }): string {
  const head = [
    `# Office conversation — ${p.delegationId}`,
    ``,
    `- status: ${p.headline ?? "(unknown)"}`,
    `- steps: ${p.decision.steps.map((s) => `${s.name}=${s.status}`).join(" · ") || "(none)"}`,
    `- decision: ${p.decision.executable ? "EXECUTABLE" : "NOT EXECUTABLE"}${p.decision.reasons.length ? ` — ${p.decision.reasons.join("; ")}` : ""}`,
    `- targets: ${p.decision.targets.map((t) => `${t.market} ${t.weightPct}%`).join(", ") || "(none)"} · cash ${p.decision.cashPct}%`,
    ``,
    `---`,
    ``,
  ].join("\n");
  return head + p.output.trimEnd() + "\n";
}
