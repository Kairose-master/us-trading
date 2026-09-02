import type {
  AutoTradeStatus,
  Balance,
  Candle,
  Holdings,
  Order,
  OrderRequest,
  PipelineLogLine,
  PipelineNodeDetail,
  PipelineSnapshot,
  Position,
  Quote,
  RiskLimits,
  ScoredNews,
  SentimentOverview,
  SymbolInfo,
  SystemStatus,
} from "@/lib/types"

/**
 * 백엔드 API 클라이언트 — 실제 fetch. 브라우저 → /api/backend/* (Next 라우트
 * 핸들러) → 백엔드. 토큰은 서버 env(BACKEND_TOKEN)에만 있다.
 *
 * 목데이터 폴백은 없다. 백엔드가 연결되지 않았으면 ApiError(503,
 * BACKEND_NOT_CONFIGURED)를 던지고 화면은 "미연결"을 그대로 보여준다.
 * 공개 대시보드라 프록시는 읽기 전용 — 쓰기 계열은 ApiError(405)가 난다.
 */

export type Market = "us" | "crypto"

export class ApiError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function isBackendNotConfigured(e: unknown): boolean {
  return e instanceof ApiError && e.code === "BACKEND_NOT_CONFIGURED"
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/backend/${path}`, { ...init, cache: "no-store" })
  if (!res.ok) {
    let body: { error?: string; code?: string } = {}
    try {
      body = (await res.json()) as { error?: string; code?: string }
    } catch {
      /* 본문 없음 */
    }
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.code)
  }
  return (await res.json()) as T
}

const readOnly = (): never => {
  throw new ApiError(405, "공개 대시보드는 읽기 전용 — 이 동작은 백엔드 API에 직접 토큰으로 호출하세요", "READ_ONLY")
}

// ===== 계좌 (KIS 키 없으면 백엔드의 모의 계좌 — 응답의 mock 표기를 믿을 것) =====

export async function getBalance(): Promise<Balance> {
  return req("account/balance")
}

export async function getPositions(): Promise<Position[]> {
  return req("account/positions")
}

export async function getQuote(symbol: string): Promise<Quote> {
  return req(`quotes/${encodeURIComponent(symbol)}`)
}

export async function getChart(symbol: string, interval: "1m" | "5m" | "1d" = "5m", count = 120): Promise<Candle[]> {
  return req(`quotes/${encodeURIComponent(symbol)}/chart?interval=${interval}&count=${count}`)
}

export async function placeOrder(_req: OrderRequest): Promise<{ orderId: string; status: "accepted" }> {
  return readOnly()
}

export async function getOrders(status: "open" | "filled" | "all" = "all"): Promise<Order[]> {
  return req(`orders?status=${status}`)
}

export async function cancelOrder(_orderId: string): Promise<{ ok: true }> {
  return readOnly()
}

// ===== 전략 =====

// ===== 리스크 =====

export async function getRiskLimits(): Promise<RiskLimits> {
  return req("risk/limits")
}

export async function patchRiskLimits(
  _patch: Partial<Pick<RiskLimits, "maxOrderAmountUsd" | "maxDailyLossUsd" | "maxSymbolWeightPct" | "maxOpenPositions">>,
): Promise<{ ok: true }> {
  return readOnly()
}

export async function activateKillSwitch(): Promise<{ ok: true }> {
  return readOnly()
}

export async function deactivateKillSwitch(): Promise<{ ok: true }> {
  return readOnly()
}

// ===== 시스템 =====

export async function getSystemStatus(): Promise<SystemStatus> {
  return req("system/status")
}

/** 백엔드에 심볼 검색 API가 없다 — 파이프라인이 추적하는 심볼 목록을 그대로 쓴다 (실제 티커) */
export async function searchSymbols(q: string): Promise<SymbolInfo[]> {
  const snap = await getPipeline("us")
  const symbols = new Set<string>()
  for (const n of snap.nodes) {
    const m = /\[(.+?)\]/.exec(n.description)
    if (m) for (const s of m[1].split(",")) symbols.add(s.trim())
  }
  const positions = await getPositions().catch(() => [] as Position[])
  const all: SymbolInfo[] = [
    ...positions.map((p) => ({ symbol: p.symbol, name: p.name, exch: p.exch })),
    ...["NVDA", "TSLA", "AAPL", "MSFT", "GOOGL"].map((s) => ({ symbol: s, name: s, exch: "NAS" as const })),
  ].filter((v, i, arr) => arr.findIndex((x) => x.symbol === v.symbol) === i)
  const query = q.trim().toLowerCase()
  if (!query) return all
  return all.filter((s) => s.symbol.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
}

export async function getHoldings(): Promise<Holdings> {
  return req("account/holdings")
}

// ===== 데이터/ML 파이프라인 (us = Yahoo 실시세 + Google News, crypto = Upbit + Google News) =====

const prefix = (market: Market) => (market === "crypto" ? "crypto/" : "")

export async function getPipeline(market: Market = "us"): Promise<PipelineSnapshot> {
  return req(`${prefix(market)}pipeline`)
}

export async function getPipelineNode(id: string, market: Market = "us"): Promise<PipelineNodeDetail> {
  return req(`${prefix(market)}pipeline/nodes/${encodeURIComponent(id)}`)
}

export async function getPipelineLogs(limit = 100, market: Market = "us"): Promise<PipelineLogLine[]> {
  return req(`${prefix(market)}pipeline/logs?limit=${limit}`)
}

// ===== 감성 =====

export async function getSentiment(market: Market = "us"): Promise<SentimentOverview> {
  return req(`${prefix(market)}sentiment`)
}

export async function getSentimentFeed(limit = 50, market: Market = "us"): Promise<ScoredNews[]> {
  return req(`${prefix(market)}sentiment/feed?limit=${limit}`)
}

// ===== 자동매매 =====

export async function getAutoTrade(): Promise<AutoTradeStatus> {
  return req("autotrade")
}

export async function setAutoTrade(_enabled: boolean): Promise<AutoTradeStatus> {
  return readOnly()
}

// ===== 크립토 페이퍼 장부 (Railway 볼륨에 영속) =====

export interface CryptoPaperStatus {
  tradeEnabled: boolean
  mode: "paper" | "real"
  paperSince: string | null
  paperStartKrw: number
  costs: { feePct: number; slipPct: number }
  equityKrw: number
  cashKrw: number
  positions: Array<{ symbol: string; qty: number; avgKrw: number; curKrw: number }>
  orders: Array<{ id: string; market: string; side: "buy" | "sell"; volume: number; priceKrw: number; amountKrw: number; costKrw: number; mode: string; reason: string; ts: string }>
  lastError: string | null
}

export async function getCryptoStatus(): Promise<CryptoPaperStatus> {
  return req("crypto/status")
}

export async function getPaperEquity(limit = 2000): Promise<Array<{ ts: string; equityKrw: number; cashKrw: number; positions: number }>> {
  return req(`crypto/paper/equity?limit=${limit}`)
}

// ===== 증권 오피스 결정 루프 (Handsel 대화 → 결정 → 페이퍼 매매) =====

export interface OfficeDecision {
  delegationId: string
  decidedAt: string
  source: "json-block" | "table" | "lines"
  targets: Array<{ market: string; weightPct: number }>
  cashPct: number
  steps: Array<{ name: string; status: string }>
  allPassed: boolean
  executable: boolean
  reasons: string[]
  roles: Array<{ role: string; excerpt: string }>
}

export interface OfficeRun {
  id: string
  startedAt: string
  finishedAt: string | null
  phase: "hiring" | "escrowed" | "escrow-pending" | "working" | "deciding" | "executed" | "rejected" | "failed"
  scope: string
  markets?: string[]
  retries?: number
  budgetUsd: number
  headline: string | null
  decision: OfficeDecision | null
  execution: { ts: string; orders: number; skipped: string[]; error?: string } | null
  error: string | null
}

export interface OfficeStatus {
  enabled: boolean
  configured: boolean
  handselUrl: string
  realMoneyHandsel: boolean
  allowRealMoney: boolean
  budgetUsd: number
  intervalHours: number
  running: boolean
  current: OfficeRun | null
  gate: { maxWeightPct: number; maxPositions: number }
}

export async function getOfficeStatus(): Promise<OfficeStatus> {
  return req("office/status")
}

export async function getOfficeRuns(): Promise<OfficeRun[]> {
  return req("office/runs")
}

export async function getOfficeRun(id: string): Promise<{ run: OfficeRun; conversation: string | null }> {
  return req(`office/runs/${encodeURIComponent(id)}`)
}
