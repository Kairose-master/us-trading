/**
 * 실시간 데이터/ML 파이프라인 타입.
 * 정형(시세 틱) + 비정형(뉴스) 소스를 하나의 DAG에서 처리해
 * 피처 → 알파 → 포트폴리오 → 실행 신호까지 흘려보낸다.
 */

export type PipelineStage = "ingestion" | "features" | "models" | "strategy" | "execution";

export type NodeStatus = "active" | "idle" | "error";

export interface PipelineNodeDef {
  id: string;
  stage: PipelineStage;
  name: string;
  /** 노드가 하는 일 설명 (인스펙터에 표시) */
  description: string;
  /** 인스펙터에 보여줄 핵심 코드 힌트 (실제 구현부 요약) */
  codeHint: string;
}

export interface PipelineEdge {
  from: string;
  to: string;
}

/** 노드 런타임 지표 — 전부 실측값 (계측 없는 수치는 만들지 않는다) */
export interface NodeMetrics {
  status: NodeStatus;
  /** 마지막 처리 소요시간(ms) */
  lastLatencyMs: number;
  /** EMA 평균 레이턴시(ms) */
  avgLatencyMs: number;
  /** 최근 10초 처리량 (msg/s) */
  throughputPerSec: number;
  /** 누적 처리 메시지 수 */
  totalMsgs: number;
  /** 마지막 처리 시각 ISO */
  lastRunAt: string | null;
  /** 마지막 오류 메시지 */
  lastError: string | null;
}

export interface PipelineNodeSummary extends PipelineNodeDef {
  metrics: NodeMetrics;
}

export interface PipelineNodeDetail extends PipelineNodeSummary {
  /** 마지막 출력 샘플 (열 이름 + 행) */
  sample: { columns: string[]; rows: Array<Array<string | number>> };
}

export interface PipelineLogLine {
  ts: string;
  node: string;
  message: string;
}

export interface PipelineSnapshot {
  status: "active" | "stopped";
  /** 전체 스테이지 합산 레이턴시 EMA(ms) */
  latencyMs: number;
  /** 활성 노드 / 전체 노드 */
  nodesActive: number;
  nodesTotal: number;
  /** 알파 안정성: 1 - 심볼별 |Δalpha| 평균의 EMA (0~1) */
  alphaStability: number;
  stages: PipelineStage[];
  nodes: PipelineNodeSummary[];
  edges: PipelineEdge[];
}

/** 파이프라인이 소비하는 최소 틱 형태 — KIS Quote도, Upbit 티커도 이 모양이면 흐른다 */
export interface PipelineTick {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  volume: number;
}

// ===== 파이프라인 내부 데이터 =====

export interface TechnicalFeatures {
  symbol: string;
  rsi14: number;
  momentumPct: number;
  volatilityPct: number;
  ts: string;
}

export interface MicrostructureFeatures {
  symbol: string;
  spreadBps: number;
  orderFlowImbalance: number; // (bidSize-askSize)/(bidSize+askSize)
  volumeDelta: number;
  ts: string;
}

export interface AlphaValue {
  symbol: string;
  alpha: number; // [-1, 1]
  confidence: number; // [0, 1]
  source: "technical" | "sentiment" | "ensemble";
  ts: string;
}

export interface PortfolioTarget {
  symbol: string;
  alpha: number;
  targetWeightPct: number;
  currentWeightPct: number;
  driftPct: number;
  ts: string;
}

export interface ExecutionSignal {
  symbol: string;
  side: "buy" | "sell";
  reason: string;
  strengthPct: number;
  blocked: string | null; // 리스크 관문 사유 (null = 통과)
  ts: string;
}
