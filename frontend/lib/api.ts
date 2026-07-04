import type {
  Balance,
  Candle,
  EquityPoint,
  Order,
  OrderRequest,
  Position,
  Quote,
  RiskLimits,
  Strategy,
  StrategyConfig,
  StrategyLog,
  SymbolInfo,
  SystemStatus,
} from "@/lib/types"
import { getEngine } from "@/lib/mock/engine"

/**
 * API client for the self-hosted KIS backend.
 *
 * MOCK MODE: every function below simulates the real REST endpoint with the
 * exact response shape. To connect the real backend, replace the bodies with
 * `fetch(`${BASE_URL}${path}`)` calls — nothing else in the app needs to change.
 */

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function delay(ms = 300 + Math.random() * 300) {
  return new Promise((r) => setTimeout(r, ms))
}

// GET /api/account/balance
export async function getBalance(): Promise<Balance> {
  await delay()
  return getEngine().getBalance()
}

// GET /api/account/positions
export async function getPositions(): Promise<Position[]> {
  await delay()
  return getEngine().getPositions()
}

// GET /api/quotes/:symbol
export async function getQuote(symbol: string): Promise<Quote> {
  await delay(150 + Math.random() * 150)
  const q = getEngine().getQuote(symbol)
  if (!q) throw new ApiError(404, `종목을 찾을 수 없습니다: ${symbol}`)
  return q
}

// GET /api/quotes/:symbol/chart?interval=1m|5m|1d&count=120
export async function getChart(symbol: string, interval: "1m" | "5m" | "1d" = "5m", count = 120): Promise<Candle[]> {
  await delay()
  return getEngine().getChart(symbol, interval, count)
}

// POST /api/orders — 409 {error} if a risk limit blocks it
export async function placeOrder(req: OrderRequest): Promise<{ orderId: string; status: "accepted" }> {
  await delay()
  const res = getEngine().placeOrder(req)
  if (!res.ok) throw new ApiError(409, res.error)
  return { orderId: res.orderId, status: "accepted" }
}

// GET /api/orders?status=open|filled|all
export async function getOrders(status: "open" | "filled" | "all" = "all"): Promise<Order[]> {
  await delay()
  return getEngine().getOrders(status)
}

// DELETE /api/orders/:orderId
export async function cancelOrder(orderId: string): Promise<{ ok: true }> {
  await delay()
  const ok = getEngine().cancelOrder(orderId)
  if (!ok) throw new ApiError(409, "취소할 수 없는 주문입니다 (이미 체결/취소됨).")
  return { ok: true }
}

// GET /api/strategies
export async function getStrategies(): Promise<Strategy[]> {
  await delay()
  return getEngine().getStrategies()
}

// POST /api/strategies/:id/start
export async function startStrategy(id: string): Promise<{ ok: true }> {
  await delay()
  const ok = getEngine().setStrategyStatus(id, "running")
  if (!ok) throw new ApiError(409, "전략을 시작할 수 없습니다 (킬 스위치 활성화 상태).")
  return { ok: true }
}

// POST /api/strategies/:id/stop
export async function stopStrategy(id: string): Promise<{ ok: true }> {
  await delay()
  getEngine().setStrategyStatus(id, "stopped")
  return { ok: true }
}

// PATCH /api/strategies/:id/config
export async function patchStrategyConfig(id: string, config: Partial<StrategyConfig>): Promise<{ ok: true }> {
  await delay()
  const ok = getEngine().patchStrategyConfig(id, config)
  if (!ok) throw new ApiError(404, "전략을 찾을 수 없습니다.")
  return { ok: true }
}

// GET /api/strategies/:id/logs?limit=100
export async function getStrategyLogs(id: string, limit = 100): Promise<StrategyLog[]> {
  await delay()
  return getEngine().getLogs(id, limit)
}

// GET /api/risk/limits
export async function getRiskLimits(): Promise<RiskLimits> {
  await delay()
  return getEngine().getRiskLimits()
}

// PATCH /api/risk/limits
export async function patchRiskLimits(
  patch: Partial<Pick<RiskLimits, "maxOrderAmountUsd" | "maxDailyLossUsd" | "maxSymbolWeightPct" | "maxOpenPositions">>,
): Promise<{ ok: true }> {
  await delay()
  getEngine().patchRiskLimits(patch)
  return { ok: true }
}

// POST /api/risk/killswitch
export async function activateKillSwitch(): Promise<{ ok: true; stoppedStrategies: string[] }> {
  await delay()
  const stoppedStrategies = getEngine().activateKillSwitch()
  return { ok: true, stoppedStrategies }
}

// (convenience, mirrors backend endpoint for manual resume)
export async function deactivateKillSwitch(): Promise<{ ok: true }> {
  await delay()
  getEngine().deactivateKillSwitch()
  return { ok: true }
}

// GET /api/system/status
export async function getSystemStatus(): Promise<SystemStatus> {
  await delay(120)
  return getEngine().getSystemStatus()
}

// GET /api/symbols?q= (autocomplete source)
export async function searchSymbols(q: string): Promise<SymbolInfo[]> {
  await delay(120)
  const query = q.trim().toLowerCase()
  const all = getEngine().getSymbols()
  if (!query) return all
  return all.filter((s) => s.symbol.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
}

// GET /api/account/equity-curve?days=30
export async function getEquityCurve(days = 30): Promise<EquityPoint[]> {
  await delay()
  return getEngine().getEquityCurve(days)
}
