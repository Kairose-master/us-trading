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

export interface OfficeRole {
  id: string
  name: string
  nameKo: string
  tool: string | null
  dependsOn: string[]
  reviewOf?: string
  stepTitle: string
  color: string
}

export interface OfficeRoster {
  templateId: string
  roles: OfficeRole[]
  edges: Array<{ from: string; to: string; kind: "handoff" | "review" }>
  workerUrl: string
}

export interface OfficeRun {
  id: string
  startedAt: string
  finishedAt: string | null
  phase: "hiring" | "escrowed" | "escrow-pending" | "working" | "deciding" | "executed" | "rejected" | "failed"
  scope: string
  markets?: string[]
  retries?: number
  steps?: number
  stepStatuses?: Record<string, string>
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

export async function getOfficeRoster(): Promise<OfficeRoster> {
  return req("office/roster")
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

// ===== 계정·금고 (세션은 httpOnly 쿠키 — 프록시가 X-Session으로 옮긴다) =====

export interface AuthUser {
  id: string
  email: string
  role: "owner" | "member"
  createdAt: string
}
export interface CredentialSources {
  vaultUnlocked: boolean
  owner: string | null
  upbit: "env" | "vault" | null
  kis: "env" | "vault" | null
}
export interface MaskedKeys {
  upbit: { updatedAt: string; last4: Record<string, string> } | null
  kis: { updatedAt: string; last4: Record<string, string> } | null
}

async function write<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch(`/api/backend/${path}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; code?: string }
    throw new ApiError(res.status, j.error ?? `HTTP ${res.status}`, j.code)
  }
  return json as T
}

export async function getAuthConfig(): Promise<{ users: number; signupOpen: boolean; vaultUnlocked: boolean }> {
  return req("auth/config")
}
export async function authMe(): Promise<{ user: AuthUser; credentials: CredentialSources }> {
  return req("auth/me")
}
export async function login(email: string, password: string): Promise<{ user: AuthUser }> {
  return write("auth/login", "POST", { email, password })
}
export async function register(email: string, password: string): Promise<{ user: AuthUser }> {
  return write("auth/register", "POST", { email, password })
}
export async function logout(): Promise<{ ok: true }> {
  return write("auth/logout", "POST", {})
}
export async function getKeys(): Promise<{ vaultUnlocked: boolean; keys: MaskedKeys; sources: CredentialSources }> {
  return req("keys")
}
export async function putKeys(provider: "upbit" | "kis", keys: Record<string, string>): Promise<{ ok: true; keys: MaskedKeys }> {
  return write(`keys/${provider}`, "PUT", keys)
}
export async function deleteKeys(provider: "upbit" | "kis"): Promise<{ ok: true; keys: MaskedKeys }> {
  return write(`keys/${provider}`, "DELETE")
}

// ===== 수집 감독자 (self-healing) — 읽기는 공개, 조작은 로그인(owner) 세션 =====

export type SourceStatus = "healthy" | "degraded" | "failed" | "paused" | "broken"
export interface SourceState {
  id: string
  name: string
  market: "us" | "crypto" | "all"
  feedsNode: string
  status: SourceStatus
  intervalMs: number
  slaMs: number
  replayable: boolean
  consecutiveFailures: number
  attempt: number
  backoffMs: number
  nextRunAt: string | null
  lastRunAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  lagMs: number
  rowsTotal: number
  rowsPerSec: number
  failures: number
  recoveries: number
  brokenUntil: string | null
  inFlight: boolean
}
export interface SupervisorSnapshot {
  ts: string
  paused: boolean
  autoRecovery: boolean
  healthy: number
  total: number
  failing: number
  sources: SourceState[]
}
export interface OpsLogLine {
  ts: string
  source: string
  level: "info" | "ok" | "warn" | "error"
  message: string
}

export async function getSupervisor(market?: Market): Promise<SupervisorSnapshot> {
  return req(`ops/supervisor${market ? `?market=${market}` : ""}`)
}
export async function getSupervisorLogs(limit = 100, market?: Market): Promise<OpsLogLine[]> {
  return req(`ops/supervisor/logs?limit=${limit}${market ? `&market=${market}` : ""}`)
}
export async function supervisorAction(action: "pause" | "resume" | "heal"): Promise<{ ok: true }> {
  return write(`ops/supervisor/${action}`, "POST", {})
}
export async function supervisorAutoRecovery(on: boolean): Promise<{ ok: true }> {
  return write("ops/supervisor/auto-recovery", "POST", { on })
}
export async function breakSource(id: string, seconds: number): Promise<{ ok: true }> {
  return write(`ops/supervisor/${encodeURIComponent(id)}/break`, "POST", { seconds })
}

// ===== 진화 — 전략 개체군 (PyGAD, 페이퍼) =====

export interface EvoGenes {
  momWindow: number
  volWindow: number
  pBullMin: number
  topK: number
  capPct: number
  rebalanceDays: number
  volTargetPct: number
  exposureMax: number
  peerAlloc: number
  peerTopN: number
}
export interface EvoAgent {
  id: string
  name: string
  archetype: string
  genes: EvoGenes
  vector: number[]
  generationBorn: number
  bornAt: string
  parents: string[]
  alive: boolean
  diedAt: string | null
  causeOfDeath: string | null
  capitalKrw: number
  seedKrw: number
  peakKrw: number
  exam: { fitness: number; sharpe: number; totalReturnPct: number; maxDrawdownPct: number; rebalances: number; avgExposure: number } | null
  fitnessHistory: Array<{ gen: number; fitness: number }>
  capitalHistory: Array<{ date: string; capitalKrw: number }>
  lastWeights: Array<{ market: string; weightPct: number }>
  peers: string[]
  bottomStreak: number
  children: number
  tribe: string
  events: Array<{ gen: number; type: "born" | "mutated" | "merged" | "absorbed" | "forked" | "retired"; detail: string }>
  forked: boolean
}
export interface EvoGeneration {
  gen: number
  at: string
  examWindow: { from: string; to: string }
  alive: number
  births: number
  deaths: number
  mutations: number
  merges: number
  forks: number
  diversity: number
  topFitness: number
  meanFitness: number
  championId: string | null
  engine: string
  vaultKrw: number
  totalCapitalKrw: number
}
export interface EvoStatus {
  enabled: boolean
  intervalHours: number
  generation: number
  running: boolean
  lastGenerationAt: string | null
  lastMarkedDate: string | null
  alive: number
  total: number
  popMax: number
  vaultKrw: number
  totalCapitalKrw: number
  seedKrw: number
  examDays: number
  champion: { id: string; name: string; archetype: string; fitness: number | null } | null
  diversity: number
  tribes: Array<{ tribe: string; name: string; alive: number; capitalKrw: number }>
  archetypes: Array<{ archetype: string; alive: number }>
  genes: Array<{ key: keyof EvoGenes; min: number; max: number; int: boolean; label: string }>
  rules: { starveRatio: number; bottomQuantile: number; bottomStreakDeath: number; minAgeGens: number; childShare: number; mutationBase: number; diversityFloor: number; mergeDistance: number; mergeDependence: number }
  squad: { members: Array<{ id: string; name: string; archetype: string; fitness: number; capitalKrw: number; lastWeights: Array<{ market: string; weightPct: number }> }>; targets: Array<{ market: string; weightPct: number }> }
  history: EvoGeneration[]
}
export interface EvoLog {
  ts: string
  level: "info" | "ok" | "warn" | "error"
  message: string
}
export async function getEvolution(): Promise<EvoStatus> {
  return req("evolution")
}
export async function getEvoAgents(): Promise<EvoAgent[]> {
  return req("evolution/agents")
}
export async function getEvoLog(limit = 80): Promise<EvoLog[]> {
  return req(`evolution/log?limit=${limit}`)
}
export async function getEvoLineage(): Promise<{ configured: boolean; report: string | null; automaton: string | null }> {
  return req("evolution/lineage")
}
export async function evoStep(): Promise<EvoGeneration> {
  return write("evolution/step", "POST", {})
}
export async function evoDeploy(): Promise<{ squad: EvoStatus["squad"]; result: { orders: unknown[]; skipped: string[]; error?: string } }> {
  return write("evolution/deploy", "POST", {})
}

// ── 통합 제어 평면 (control plane) ────────────────────────────────────────
export type ControlEngineId = "scanner" | "office" | "evolution" | "signals"
export interface ControlTarget { market: string; weightPct: number }
export interface ControlProposal {
  id: string
  engine: ControlEngineId
  ts: string
  expiresAt: string
  targets: ControlTarget[]
  confidence: number
  evidence: string
  ref: string | null
}
export interface ControlDecision {
  id: string
  ts: string
  status: "pending" | "executed" | "rejected" | "skipped" | "blocked"
  targets: ControlTarget[]
  cashPct: number
  contributions: Array<{ engine: ControlEngineId; weight: number; confidence: number; proposalId: string; targets: ControlTarget[] }>
  rationale: string[]
  constraints: string[]
  turnoverPct: number
  execution: { ts: string; orders: number; skipped: string[]; error?: string } | null
  by: "autopilot" | "operator" | null
}
export interface ControlEngine {
  id: ControlEngineId
  name: string
  nameKo: string
  description: string
  enabled: boolean
  weight: number
  share: number
  lastProposal: ControlProposal | null
  proposals: number
  cumReturnPct: number
  days: number
}
export interface ControlPolicy {
  maxWeightPct: number
  maxPositions: number
  cashFloorPct: number
  grossMaxPct: number
  minTurnoverPct: number
  minIntervalMin: number
  proposalTtlH: number
  eta: number
}
export interface ControlStatus {
  autopilot: boolean
  mode: string
  killSwitch: boolean
  policy: ControlPolicy
  engines: ControlEngine[]
  proposals: ControlProposal[]
  pending: ControlDecision | null
  decisions: ControlDecision[]
  lastExecutedAt: string | null
  lastMarkedDate: string | null
  holdings: ControlTarget[]
  equityKrw: number
  cashKrw: number
}
export async function getControl(): Promise<ControlStatus> {
  return req("control")
}
export async function setAutopilot(on: boolean): Promise<{ ok: true }> {
  return write("control/autopilot", "POST", { on })
}
export async function approveDecision(): Promise<ControlDecision> {
  return write("control/approve", "POST", {})
}
export async function rejectDecision(): Promise<ControlDecision> {
  return write("control/reject", "POST", {})
}
export async function setEngine(id: ControlEngineId, patch: { enabled?: boolean; weight?: number }): Promise<{ ok: true }> {
  return write(`control/engines/${id}`, "POST", patch)
}
export async function setControlPolicy(patch: Partial<ControlPolicy>): Promise<{ ok: true }> {
  return write("control/policy", "POST", patch)
}
export async function arbitrateNow(): Promise<ControlDecision | null> {
  return write("control/arbitrate", "POST", {})
}
