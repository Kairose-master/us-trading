/**
 * 증권 오피스 로스터 — 노드(에이전트 역할) 하나에 전용 실도구 하나.
 *
 * Handsel 템플릿 `securities-floor`(handsel/lib/office-world-data.ts)와 role id·
 * 의존 관계가 1:1로 맞아야 한다. 여기가 백엔드 쪽 단일 정의다: hire_office에
 * 넘기는 커넥터, 결정 관문의 단계 수, /office 그래프의 노드·엣지가 전부 이
 * 배열에서 나온다.
 *
 * 협의 구조 (Handsel 협업 원시연산 그대로):
 *   - dependsOn  : 상류 산출물이 브리프로 주입된다 (핸드오프 = 대화)
 *   - reviewOf   : 동료 검토. 검토 대상의 escrow는 승인 전까지 묶이고, REVISE는
 *                  대상 워커에게 되돌아가 수정본을 낸다 (= 협상 라운드)
 *   - chair      : 전부를 읽고 하나의 결정을 쓴다 (= 합의). 결정 JSON 블록은 여기.
 */
export type OfficeRoleId =
  | "chart-analyst"
  | "news-analyst"
  | "flow-analyst"
  | "macro-analyst"
  | "quant-modeler"
  | "risk-officer"
  | "rebalance-planner"
  | "red-team"
  | "chair";

export interface OfficeRole {
  id: OfficeRoleId;
  name: string;
  nameKo: string;
  /** 워커 MCP 툴 — null이면 플랫폼 에이전트(상류 산출물만 읽고 쓴다) */
  tool: string | null;
  dependsOn: OfficeRoleId[];
  reviewOf?: OfficeRoleId;
  /** Handsel 템플릿 스텝 제목의 접두 — delegation_status 줄과 매칭할 때 쓴다 */
  stepTitle: string;
  color: string;
}

export const OFFICE_TEMPLATE_ID = "securities-floor";

export const OFFICE_ROSTER: OfficeRole[] = [
  { id: "chart-analyst", name: "Chart Analyst", nameKo: "차트", tool: "upbit_market_report", dependsOn: [], stepTitle: "Chart analysis", color: "#60a5fa" },
  { id: "news-analyst", name: "News Analyst", nameKo: "뉴스", tool: "upbit_news_report", dependsOn: [], stepTitle: "News & filings analysis", color: "#f472b6" },
  { id: "flow-analyst", name: "Flow Analyst", nameKo: "수급", tool: "upbit_flow_report", dependsOn: [], stepTitle: "Order-flow analysis", color: "#34d399" },
  { id: "macro-analyst", name: "Macro Analyst", nameKo: "매크로", tool: "macro_report", dependsOn: [], stepTitle: "Macro & cross-asset read", color: "#fbbf24" },
  { id: "quant-modeler", name: "Quant Modeler", nameKo: "퀀트", tool: "upbit_quant_report", dependsOn: ["chart-analyst", "news-analyst", "flow-analyst", "macro-analyst"], stepTitle: "Quant model", color: "#a78bfa" },
  { id: "risk-officer", name: "Risk Officer", nameKo: "리스크", tool: "basket_risk_report", dependsOn: [], reviewOf: "quant-modeler", stepTitle: "Risk review", color: "#f87171" },
  { id: "rebalance-planner", name: "Rebalance Planner", nameKo: "리밸런스", tool: "upbit_rebalance_draft", dependsOn: ["quant-modeler", "risk-officer"], stepTitle: "Rebalance proposal", color: "#22d3ee" },
  { id: "red-team", name: "Red Team", nameKo: "레드팀", tool: "upbit_backtest_report", dependsOn: [], reviewOf: "rebalance-planner", stepTitle: "Red-team challenge", color: "#fb923c" },
  { id: "chair", name: "Investment Committee Chair", nameKo: "위원장", tool: null, dependsOn: ["rebalance-planner", "red-team"], stepTitle: "Investment committee decision", color: "#e5e7eb" },
];

export const OFFICE_STEP_COUNT = OFFICE_ROSTER.length;

/** 그래프 엣지 — 핸드오프(dependsOn)와 검토(reviewOf)를 구분해 그린다 */
export function rosterEdges(): Array<{ from: OfficeRoleId; to: OfficeRoleId; kind: "handoff" | "review" }> {
  const edges: Array<{ from: OfficeRoleId; to: OfficeRoleId; kind: "handoff" | "review" }> = [];
  for (const r of OFFICE_ROSTER) {
    for (const d of r.dependsOn) edges.push({ from: d, to: r.id, kind: "handoff" });
    if (r.reviewOf) edges.push({ from: r.reviewOf, to: r.id, kind: "review" });
  }
  return edges;
}

/** delegation_status의 단계 이름 → 역할 (접두 매칭) */
export function roleForStep(stepName: string): OfficeRole | null {
  return OFFICE_ROSTER.find((r) => stepName.startsWith(r.stepTitle)) ?? null;
}
