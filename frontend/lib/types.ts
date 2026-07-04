export type Exchange = "NAS" | "NYS" | "AMS"
export type MarketSession = "pre" | "regular" | "after" | "closed"
export type OrderSide = "buy" | "sell"
export type OrderType = "limit" | "market"
export type OrderSession = "regular" | "extended"
export type OrderStatus = "open" | "partial" | "filled" | "cancelled" | "rejected"
export type WsStatus = "connected" | "reconnecting" | "disconnected"
export type StrategyStatus = "running" | "stopped" | "error"
export type LogLevel = "INFO" | "WARN" | "ERROR"

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

export interface StrategyConfig {
  entryRule: string
  stopLossPct: number
  takeProfitPct: number
  maxPositions: number
  maxAmountPerSymbolUsd: number
  allowedSession: OrderSession
}

export interface Strategy {
  id: string
  name: string
  status: StrategyStatus
  todayPnlUsd: number
  positionCount: number
  config: StrategyConfig
}

export interface StrategyLog {
  ts: string
  level: LogLevel
  message: string
  context?: Record<string, unknown>
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

// WebSocket relay message shapes (WS /ws/live)
export type WsMessage =
  | { ch: `quote:${string}`; data: { last: number; change: number; changePct: number; bid: number; ask: number; volume: number; ts: string } }
  | { ch: "execution"; data: { orderId: string; symbol: string; side: OrderSide; qty: number; price: number; ts: string } }
  | { ch: "position"; data: Position[] }
  | { ch: "session"; data: { marketSession: MarketSession } }
