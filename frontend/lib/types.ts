export type Exchange = "NAS" | "NYS" | "AMS"
export type MarketSession = "pre" | "regular" | "after" | "closed"
export type OrderSide = "buy" | "sell"
export type OrderType = "limit" | "market"
export type OrderSession = "regular" | "extended"
export type OrderStatus = "open" | "partial" | "filled" | "cancelled" | "rejected"
export type WsStatus = "connected" | "reconnecting" | "disconnected"
export type LogLevel = "INFO" | "WARN" | "ERROR"

export interface CryptoHolding {
  symbol: string
  qty: number
  avgKrw: number
  curKrw: number
  valueKrw: number
  pnlKrw: number
  pnlPct: number
  weightPct: number
}

/** /account/holdings — 크립토 페이퍼 장부 + 미국 장부(KIS 실계좌 또는 페이퍼) + 실환율. 전부 실기록 */
export interface Holdings {
  ts: string
  fx: { rate: number; ts: string; source: string }
  crypto: {
    mode: "paper" | "real"
    hasKeys: boolean
    since: string | null
    startKrw: number
    cashKrw: number
    equityKrw: number
    pnlKrw: number
    pnlPct: number
    positions: CryptoHolding[]
  }
  us: {
    connected: boolean
    mode: "paper" | "mock" | "real"
    startUsd: number
    cashUsd: number
    equityUsd: number
    pnlUsd: number
    pnlPct: number
    positions: Position[]
  }
  totalKrw: number | null
}

export interface Balance {
  cashUsd: number
  totalEquityUsd: number
  todayPnlUsd: number
  todayPnlPct: number
  totalPnlUsd: number
  totalPnlPct: number
  fxRate: number // KRW per USD
}

export interface Position {
  symbol: string
  name: string
  exch: Exchange
  qty: number
  avgPrice: number
  curPrice: number
  pnlUsd: number
  pnlPct: number
  weightPct: number
  halted: boolean
}

export interface Quote {
  symbol: string
  name: string
  exch: Exchange
  last: number
  change: number
  changePct: number
  volume: number
  open: number
  high: number
  low: number
  prevClose: number
  bid: number
  bidSize: number
  ask: number
  askSize: number
  halted: boolean
  session: MarketSession
}

export interface Candle {
  t: string // ISO
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface OrderRequest {
  symbol: string
  exch: Exchange
  side: OrderSide
  orderType: OrderType
  qty: number
  price?: number
  session: OrderSession
}

export interface Order {
  orderId: string
  symbol: string
  name: string
  exch: Exchange
  side: OrderSide
  orderType: OrderType
  session: OrderSession
  qty: number
  filledQty: number
  price: number
  avgFillPrice: number
  status: OrderStatus
  createdAt: string
}

export interface RiskLimits {
  maxOrderAmountUsd: number
  maxDailyLossUsd: number
  maxSymbolWeightPct: number
  maxOpenPositions: number
  usage: {
    orderAmountTodayUsd: number
    dailyLossTodayUsd: number
    openPositions: number
  }
}

export interface SystemStatus {
  ws: WsStatus
  apiUsagePct: number
  kisTokenExpiresAt: string
  killSwitchActive: boolean
  marketSession: MarketSession
  nextSessionStartEt: string
}

export interface SymbolInfo {
  symbol: string
  name: string
  exch: Exchange
}

export interface EquityPoint {
  date: string // YYYY-MM-DD
  equityUsd: number
}

// ===== 데이터/ML 파이프라인 (백엔드 /api/pipeline* 응답과 동일 형태) =====

export type PipelineStage = "ingestion" | "features" | "models" | "strategy" | "execution"
export type PipelineNodeStatus = "active" | "idle" | "error"

export interface PipelineNodeMetrics {
  status: PipelineNodeStatus
  lastLatencyMs: number
  avgLatencyMs: number
  throughputPerSec: number
  totalMsgs: number
  lastRunAt: string | null
  lastError: string | null
}

export interface PipelineNode {
  id: string
  stage: PipelineStage
  name: string
  description: string
  codeHint: string
  metrics: PipelineNodeMetrics
}

export interface PipelineNodeDetail extends PipelineNode {
  sample: { columns: string[]; rows: Array<Array<string | number>> }
}

export interface PipelineEdge {
  from: string
  to: string
}

export interface PipelineLogLine {
  ts: string
  node: string
  message: string
}

export interface PipelineSnapshot {
  status: "active" | "stopped"
  latencyMs: number
  nodesActive: number
  nodesTotal: number
  alphaStability: number
  stages: PipelineStage[]
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}

// ===== 감성 (백엔드 /api/sentiment* 응답과 동일 형태) =====

export type SentimentLabel = "BULLISH" | "BEARISH" | "NEUTRAL"

export interface SymbolSentiment {
  symbol: string
  score: number
  label: SentimentLabel
  mentions: number
  topDriver: string | null
  updatedAt: string | null
}

export interface ScoredNews {
  id: string
  symbol: string
  title: string
  source: string
  url: string | null
  publishedAt: string
  fetchedAt: string
  score: number
  confidence: number
  label: SentimentLabel
  evidence: string[]
  assessment: string
}

export interface SentimentOverview {
  index: number
  label: SentimentLabel
  totalMentions: number
  symbols: SymbolSentiment[]
  sources: Array<{ name: string; count: number }>
}

// ===== 자동매매 (백엔드 /api/autotrade 응답과 동일 형태) =====

export interface AutoTradeRecord {
  ts: string
  symbol: string
  side: OrderSide
  qty: number
  refPrice: number
  orderId: string | null
  outcome: "accepted" | "blocked" | "error"
  detail: string
}

export interface AutoTradeStatus {
  enabled: boolean
  startedAt: string | null
  killSwitchActive: boolean
  mock: boolean
  kisMode: "mock" | "real"
  executedToday: number
  recent: AutoTradeRecord[]
}

// WebSocket relay message shapes (WS /ws/live)
export type WsMessage =
  | { ch: `quote:${string}`; data: { last: number; change: number; changePct: number; bid: number; ask: number; volume: number; ts: string } }
  | { ch: "execution"; data: { orderId: string; symbol: string; side: OrderSide; qty: number; price: number; ts: string } }
  | { ch: "position"; data: Position[] }
  | { ch: "session"; data: { marketSession: MarketSession } }
  | { ch: "pipeline"; data: PipelineSnapshot }
  | { ch: "pipeline:log"; data: PipelineLogLine }
  | { ch: "control"; data: unknown }
  | { ch: "control:decision"; data: unknown }
  | { ch: "sentiment"; data: { scored: ScoredNews[] } }
