/**
 * 전략 유전자 — 로테이션 전략 하나를 결정하는 숫자 10개. 전부 실수 벡터라 PyGAD의
 * gene_space에 그대로 들어간다. 이름·범위·정수 여부가 여기 한 곳에 있고, 파이썬 쪽은
 * 이 배열을 JSON으로 받는다 (두 정의가 어긋날 수 없다).
 */
export interface GeneSpec {
  key: keyof Genes;
  min: number;
  max: number;
  int: boolean;
  label: string;
}

export interface Genes {
  momWindow: number; // 모멘텀 룩백(일)
  volWindow: number; // 변동성 창(일)
  pBullMin: number; // HMM 강세 belief 하한 (레짐 게이트)
  topK: number; // 보유 종목 수
  capPct: number; // 종목당 상한(%)
  rebalanceDays: number; // 리밸런스 주기(일)
  volTargetPct: number; // 일간 포트폴리오 변동성 목표(%) → 노출 스케일
  exposureMax: number; // 최대 노출(0~1)
  peerAlloc: number; // 자본 중 동료 에이전트에 위탁하는 비율
  peerTopN: number; // 위탁 대상 동료 수 (적합도 상위)
  // ── 오피스 유전자: 어떤 실도구(데스크)를 빌리고, 그 보고서를 얼마나 믿는가 ──
  // 0/1 정수 유전자. 데스크는 실제 MCP 호출이고 세대마다 자본에서 임대료가 빠진다.
  // 도구를 쓰지 않는 개체는 공짜지만 눈이 없고, 다 쓰는 개체는 눈이 많지만 비싸다.
  deskChart: number; // upbit_market_report — MA20 추세·HMM 국면 (차트 스킬: 하락 추세 종목 제외)
  deskNews: number; // upbit_news_report — 실제 헤드라인 감성 (뉴스 스킬: BEARISH 종목 거부, 감성 기울기)
  deskFlow: number; // upbit_flow_report — 호가 불균형·테이커 매수 비중 (수급 스킬: 비중 기울기)
  deskMacro: number; // macro_report — VIX·S&P·달러 (매크로 스킬: risk-off면 노출 축소)
  deskRisk: number; // basket_risk_report — 상관행렬 (리스크 스킬: 한 베팅이면 총노출 축소)
  deskWeb: number; // web_search_exa — 열린 웹 검색 결과 제목의 감성 (웹 스킬: 뉴스 데스크의 2차 의견)
  toolTrust: number; // 보고서가 타깃을 얼마나 움직이는가 (0=장식, 1=전면 반영)
}

export const GENE_SPECS: GeneSpec[] = [
  { key: "momWindow", min: 5, max: 90, int: true, label: "모멘텀 룩백" },
  { key: "volWindow", min: 10, max: 60, int: true, label: "변동성 창" },
  { key: "pBullMin", min: 0, max: 0.9, int: false, label: "P(강세) 하한" },
  { key: "topK", min: 1, max: 8, int: true, label: "보유 종목 수" },
  { key: "capPct", min: 10, max: 60, int: false, label: "종목 상한 %" },
  { key: "rebalanceDays", min: 1, max: 21, int: true, label: "리밸런스 주기" },
  { key: "volTargetPct", min: 0.5, max: 6, int: false, label: "변동성 목표 %/d" },
  { key: "exposureMax", min: 0.2, max: 1, int: false, label: "최대 노출" },
  { key: "peerAlloc", min: 0, max: 0.5, int: false, label: "동료 위탁 비율" },
  { key: "peerTopN", min: 1, max: 5, int: true, label: "위탁 동료 수" },
  { key: "deskChart", min: 0, max: 1, int: true, label: "차트 데스크" },
  { key: "deskNews", min: 0, max: 1, int: true, label: "뉴스 데스크" },
  { key: "deskFlow", min: 0, max: 1, int: true, label: "수급 데스크" },
  { key: "deskMacro", min: 0, max: 1, int: true, label: "매크로 데스크" },
  { key: "deskRisk", min: 0, max: 1, int: true, label: "리스크 데스크" },
  { key: "deskWeb", min: 0, max: 1, int: true, label: "웹 검색 데스크" },
  { key: "toolTrust", min: 0, max: 1, int: false, label: "도구 신뢰도" },
];

/** 데스크 유전자 키 — 카탈로그(capabilities.ts)와 1:1 */
export const DESK_GENES = ["deskChart", "deskNews", "deskFlow", "deskMacro", "deskRisk", "deskWeb"] as const satisfies ReadonlyArray<keyof Genes>;
export function desksOf(g: Genes): Array<(typeof DESK_GENES)[number]> {
  return DESK_GENES.filter((k) => g[k] >= 1);
}

/** 구버전 벡터(10유전자)를 현재 길이로 — 데스크는 전부 0(눈 없음), 신뢰도 0.5. 진화가 스스로 켜야 한다 */
export function upgradeVector(v: GeneVector): GeneVector {
  if (v.length >= GENE_SPECS.length) return v.slice(0, GENE_SPECS.length);
  return GENE_SPECS.map((s, i) => (i < v.length ? v[i] : s.key === "toolTrust" ? 0.5 : s.min));
}

export type GeneVector = number[]; // GENE_SPECS 순서

let seed = 20260902;
/** 결정적 난수 (재현 가능한 진화) — mulberry32 */
export function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function reseed(s: number) {
  seed = s | 0;
}

export function clampGene(spec: GeneSpec, v: number): number {
  const c = Math.min(spec.max, Math.max(spec.min, v));
  return spec.int ? Math.round(c) : +c.toFixed(4);
}

export function randomVector(): GeneVector {
  return GENE_SPECS.map((g) => clampGene(g, g.min + rand() * (g.max - g.min)));
}

export function toGenes(v: GeneVector): Genes {
  const g = {} as Genes;
  GENE_SPECS.forEach((s, i) => {
    (g as unknown as Record<string, number>)[s.key] = clampGene(s, v[i] ?? s.min);
  });
  return g;
}

export function toVector(g: Genes): GeneVector {
  return GENE_SPECS.map((s) => clampGene(s, g[s.key]));
}

/** 유전자에서 읽히는 원형(archetype) — 릴의 MULTI_SIGNAL / BREAKOUT_HUNTER 식 군집 라벨 */
export function archetypeOf(g: Genes): string {
  const desks = desksOf(g).length;
  if (desks >= 4 && g.toolTrust >= 0.5) return "FULL_OFFICE";
  if (desks >= 2 && g.toolTrust >= 0.4) return "TOOL_USER";
  if (g.pBullMin >= 0.6) return "REGIME_GATED";
  if (g.momWindow <= 14) return "MOMENTUM_SPRINTER";
  if (g.momWindow >= 50) return "TREND_RIDER";
  if (g.topK <= 2) return "CONCENTRATOR";
  if (g.topK >= 6) return "DIVERSIFIER";
  if (g.peerAlloc >= 0.3) return "FUND_OF_AGENTS";
  if (g.volTargetPct <= 1.5) return "LOW_VOL";
  return "BALANCED";
}

export const ARCHETYPES = ["FULL_OFFICE", "TOOL_USER", "REGIME_GATED", "MOMENTUM_SPRINTER", "TREND_RIDER", "CONCENTRATOR", "DIVERSIFIER", "FUND_OF_AGENTS", "LOW_VOL", "BALANCED"];

/** 유전 거리 (정규화 L2) — 자식의 부모 귀속·군집 배치에 쓴다 */
export function geneDistance(a: GeneVector, b: GeneVector): number {
  let s = 0;
  GENE_SPECS.forEach((g, i) => {
    const d = ((a[i] ?? 0) - (b[i] ?? 0)) / (g.max - g.min);
    s += d * d;
  });
  return Math.sqrt(s / GENE_SPECS.length);
}
