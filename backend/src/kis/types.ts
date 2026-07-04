export type Exchange = "NAS" | "NYS" | "AMS";
export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
export type Session = "regular" | "extended";
export type MarketSession = "pre" | "regular" | "after" | "closed";

export interface Position {
  symbol: string;
  name: string;
  exch: Exchange;
  qty: number;
  avgPrice: number;
  curPrice: number;
  pnlUsd: number;
  pnlPct: number;
  weightPct: number;
  halted: boolean;
}

export interface Order {
  orderId: string;
  symbol: string;
  name: string;
  exch: Exchange;
  side: Side;
  orderType: OrderType;
  session: Session;
  qty: number;
  filledQty: number;
  price: number;
  avgFillPrice: number;
  status: "open" | "partial" | "filled" | "cancelled" | "rejected";
  createdAt: string;
}

export interface Quote {
  symbol: string;
  name: string;
  exch: Exchange;
  last: number;
  change: number;
  changePct: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  halted: boolean;
  session: MarketSession;
}

export interface Candle {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Balance {
  cashUsd: number;
  totalEquityUsd: number;
  todayPnlUsd: number;
  todayPnlPct: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  fxRate: number;
}

export interface RiskLimits {
  maxOrderAmountUsd: number;
  maxDailyLossUsd: number;
  maxSymbolWeightPct: number;
  maxOpenPositions: number;
}

export interface RiskUsage {
  orderAmountTodayUsd: number;
  dailyLossTodayUsd: number;
  openPositions: number;
}
