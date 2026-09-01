import type {
  Candle,
  Exchange,
  MarketSession,
  Order,
  OrderRequest,
  Position,
  Quote,
  RiskLimits,
  Strategy,
  StrategyLog,
  SymbolInfo,
  SystemStatus,
  WsMessage,
  WsStatus,
} from "@/lib/types"
import { getMarketSession } from "@/lib/time"
import { PipelineSim } from "@/lib/mock/pipeline"

/**
 * In-memory mock of the self-hosted KIS backend.
 * Swap lib/api.ts to point at the real backend — nothing here is imported by pages directly.
 */

export const FX_RATE = 1380

interface SymbolState extends SymbolInfo {
  last: number
  prevClose: number
  open: number
  high: number
  low: number
  volume: number
  halted: boolean
}

const SYMBOLS: Array<Omit<SymbolState, "open" | "high" | "low" | "volume"> & { halted?: boolean }> = [
  { symbol: "GME", name: "게임스탑", exch: "NYS", last: 22.07, prevClose: 21.64, halted: false },
  { symbol: "MARA", name: "마라 홀딩스", exch: "NAS", last: 19.12, prevClose: 18.77, halted: false },
  { symbol: "COIN", name: "코인베이스", exch: "NAS", last: 201.35, prevClose: 205.1, halted: false },
  { symbol: "AAPL", name: "애플", exch: "NAS", last: 228.4, prevClose: 226.9, halted: false },
  { symbol: "BMNR", name: "비트마인 이머전", exch: "AMS", last: 41.8, prevClose: 44.25, halted: true },
  { symbol: "NVDA", name: "엔비디아", exch: "NAS", last: 172.6, prevClose: 170.1, halted: false },
  { symbol: "TSLA", name: "테슬라", exch: "NAS", last: 312.5, prevClose: 318.2, halted: false },
  { symbol: "MSFT", name: "마이크로소프트", exch: "NAS", last: 462.1, prevClose: 458.7, halted: false },
  { symbol: "PLTR", name: "팔란티어", exch: "NYS", last: 141.3, prevClose: 138.9, halted: false },
  { symbol: "SOFI", name: "소파이", exch: "NAS", last: 17.85, prevClose: 17.6, halted: false },
]

type Listener = (msg: WsMessage) => void

function nowIso() {
  return new Date().toISOString()
}

function isoMinusMin(min: number) {
  return new Date(Date.now() - min * 60000).toISOString()
}

class MockEngine {
  symbols = new Map<string, SymbolState>()
  positions: Array<{ symbol: string; qty: number; avgPrice: number }> = [
    { symbol: "GME", qty: 40, avgPrice: 23.1 },
    { symbol: "MARA", qty: 25, avgPrice: 18.45 },
    { symbol: "COIN", qty: 3, avgPrice: 195.0 },
  ]
  cashUsd = 4820.55
  startOfDayEquity = 0
  orders: Order[] = []
  strategies: Strategy[] = [
    {
      id: "st-rsi",
      name: "RSI 역추세",
      status: "running",
      todayPnlUsd: 84.3,
      positionCount: 2,
      config: {
        entryRule: "RSI(14) < 30 진입, RSI > 55 청산",
        stopLossPct: 3,
        takeProfitPct: 6,
        maxPositions: 3,
        maxAmountPerSymbolUsd: 1500,
        allowedSession: "regular",
      },
    },
    {
      id: "st-breakout",
      name: "돌파 매매",
      status: "stopped",
      todayPnlUsd: -12.75,
      positionCount: 1,
      config: {
        entryRule: "전일 고가 +0.5% 돌파 시 진입",
        stopLossPct: 2,
        takeProfitPct: 4,
        maxPositions: 2,
        maxAmountPerSymbolUsd: 1000,
        allowedSession: "extended",
      },
    },
  ]
  riskLimits = {
    maxOrderAmountUsd: 2000,
    maxDailyLossUsd: 500,
    maxSymbolWeightPct: 40,
    maxOpenPositions: 6,
  }
  riskUsage = { orderAmountTodayUsd: 1240.5, dailyLossTodayUsd: 96.2 }
  killSwitchActive = false
  wsStatus: WsStatus = "disconnected"
  apiUsagePct = 35
  private listeners = new Set<Listener>()
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private lastPipelineEmit = 0
  private lastSession: MarketSession = getMarketSession()
  private orderSeq = 100
  private logCache = new Map<string, StrategyLog[]>()
  pipeline: PipelineSim

  constructor() {
    for (const s of SYMBOLS) {
      this.symbols.set(s.symbol, {
        ...s,
        halted: s.halted ?? false,
        open: s.prevClose * (1 + (Math.random() - 0.5) * 0.01),
        high: Math.max(s.last, s.prevClose) * 1.012,
        low: Math.min(s.last, s.prevClose) * 0.988,
        volume: Math.round(2_000_000 + Math.random() * 20_000_000),
      })
    }
    this.startOfDayEquity = this.totalEquityUsd() - 61.4
    this.seedOrders()

    // 데이터/ML 파이프라인 시뮬레이터 — 백엔드 pipeline/engine.ts와 동일 계산
    this.pipeline = new PipelineSim(
      SYMBOLS.map((s) => s.symbol),
      {
        maxSymbolWeightPct: this.riskLimits.maxSymbolWeightPct,
        check: ({ amountUsd, side, resultingSymbolWeightPct }) => {
          if (this.killSwitchActive) return "킬스위치 활성화 상태 — 모든 주문 차단됨"
          if (amountUsd > this.riskLimits.maxOrderAmountUsd) return `1회 최대 주문금액($${this.riskLimits.maxOrderAmountUsd}) 초과`
          if (side === "buy" && resultingSymbolWeightPct > this.riskLimits.maxSymbolWeightPct)
            return `종목당 최대 비중(${this.riskLimits.maxSymbolWeightPct}%) 초과`
          return null
        },
        currentWeightPct: (symbol) => {
          const pos = this.positions.find((p) => p.symbol === symbol)
          if (!pos) return 0
          const total = this.totalEquityUsd()
          return total > 0 ? ((pos.qty * (this.symbols.get(symbol)?.last ?? 0)) / total) * 100 : 0
        },
        totalEquityUsd: () => this.totalEquityUsd(),
      },
    )
    this.pipeline.onLog = (line) => this.emit({ ch: "pipeline:log", data: line })
    this.pipeline.onNews = (scored) => this.emit({ ch: "sentiment", data: { scored } })
  }

  private seedOrders() {
    const fills: Array<[string, "buy" | "sell", number, number, number]> = [
      ["GME", "buy", 10, 22.07, 34],
      ["GME", "buy", 15, 22.31, 61],
      ["MARA", "buy", 25, 18.45, 95],
      ["COIN", "buy", 1, 194.2, 130],
      ["COIN", "buy", 2, 195.4, 152],
      ["GME", "sell", 5, 22.9, 180],
      ["MARA", "sell", 8, 19.02, 215],
      ["GME", "buy", 20, 23.55, 260],
    ]
    for (const [symbol, side, qty, price, minAgo] of fills) {
      const s = this.symbols.get(symbol)!
      this.orders.push({
        orderId: `ord-${this.orderSeq++}`,
        symbol,
        name: s.name,
        exch: s.exch,
        side,
        orderType: "limit",
        session: "regular",
        qty,
        filledQty: qty,
        price,
        avgFillPrice: price,
        status: "filled",
        createdAt: isoMinusMin(minAgo),
      })
    }
    // One open limit order
    const gme = this.symbols.get("GME")!
    this.orders.push({
      orderId: `ord-${this.orderSeq++}`,
      symbol: "GME",
      name: gme.name,
      exch: gme.exch,
      side: "buy",
      orderType: "limit",
      session: "regular",
      qty: 10,
      filledQty: 0,
      price: 21.5,
      avgFillPrice: 0,
      status: "open",
      createdAt: isoMinusMin(12),
    })
  }

  // ---- pub/sub -------------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(msg: WsMessage) {
    for (const fn of this.listeners) fn(msg)
  }

  startTicking() {
    if (this.tickTimer) return
    const loop = () => {
      this.tick()
      this.tickTimer = setTimeout(loop, 1000 + Math.random() * 1000)
    }
    this.tickTimer = setTimeout(loop, 800)
  }

  stopTicking() {
    if (this.tickTimer) clearTimeout(this.tickTimer)
    this.tickTimer = null
  }

  private tick() {
    for (const s of this.symbols.values()) {
      if (s.halted) continue
      const drift = (Math.random() - 0.5) * 0.003
      s.last = Math.max(0.01, s.last * (1 + drift))
      s.high = Math.max(s.high, s.last)
      s.low = Math.min(s.low, s.last)
      s.volume += Math.round(Math.random() * 8000)
      const change = s.last - s.prevClose
      this.emit({
        ch: `quote:${s.symbol}`,
        data: {
          last: s.last,
          change,
          changePct: (change / s.prevClose) * 100,
          bid: s.last - this.spreadOf(s),
          ask: s.last + this.spreadOf(s),
          volume: s.volume,
          ts: nowIso(),
        },
      })
    }
    // 파이프라인 시뮬레이터에 틱 공급 → 1초 스로틀로 스냅샷 방송
    for (const s of this.symbols.values()) {
      if (s.halted) continue
      const spread = this.spreadOf(s)
      this.pipeline.onTick({
        symbol: s.symbol,
        last: s.last,
        bid: s.last - spread,
        ask: s.last + spread,
        bidSize: Math.round(100 + Math.random() * 900),
        askSize: Math.round(100 + Math.random() * 900),
        volume: s.volume,
      })
    }
    const now = Date.now()
    if (now - this.lastPipelineEmit > 1000) {
      this.lastPipelineEmit = now
      this.emit({ ch: "pipeline", data: this.pipeline.snapshot() })
    }
    // occasionally emit positions refresh
    if (Math.random() < 0.2) {
      this.emit({ ch: "position", data: this.getPositions() })
    }
    // session change detection
    const session = getMarketSession()
    if (session !== this.lastSession) {
      this.lastSession = session
      this.emit({ ch: "session", data: { marketSession: session } })
    }
    // wobble api usage
    this.apiUsagePct = Math.min(98, Math.max(5, this.apiUsagePct + (Math.random() - 0.5) * 6))
  }

  private spreadOf(s: SymbolState) {
    return Math.max(0.005, s.last * 0.0004)
  }

  // ---- reads ---------------------------------------------------------------

  totalEquityUsd(): number {
    const posValue = this.positions.reduce((acc, p) => acc + p.qty * (this.symbols.get(p.symbol)?.last ?? 0), 0)
    return this.cashUsd + posValue
  }

  getBalance() {
    const totalEquityUsd = this.totalEquityUsd()
    const costBasis = this.positions.reduce((acc, p) => acc + p.qty * p.avgPrice, 0)
    const posValue = totalEquityUsd - this.cashUsd
    const totalPnlUsd = posValue - costBasis
    const todayPnlUsd = totalEquityUsd - this.startOfDayEquity
    return {
      cashUsd: this.cashUsd,
      totalEquityUsd,
      todayPnlUsd,
      todayPnlPct: (todayPnlUsd / this.startOfDayEquity) * 100,
      totalPnlUsd,
      totalPnlPct: costBasis > 0 ? (totalPnlUsd / costBasis) * 100 : 0,
      fxRate: FX_RATE,
    }
  }

  getPositions(): Position[] {
    const total = this.totalEquityUsd()
    return this.positions.map((p) => {
      const s = this.symbols.get(p.symbol)!
      const value = p.qty * s.last
      const pnlUsd = (s.last - p.avgPrice) * p.qty
      return {
        symbol: p.symbol,
        name: s.name,
        exch: s.exch,
        qty: p.qty,
        avgPrice: p.avgPrice,
        curPrice: s.last,
        pnlUsd,
        pnlPct: ((s.last - p.avgPrice) / p.avgPrice) * 100,
        weightPct: (value / total) * 100,
        halted: s.halted,
      }
    })
  }

  getQuote(symbol: string): Quote | null {
    const s = this.symbols.get(symbol)
    if (!s) return null
    const spread = this.spreadOf(s)
    const change = s.last - s.prevClose
    return {
      symbol: s.symbol,
      name: s.name,
      exch: s.exch,
      last: s.last,
      change,
      changePct: (change / s.prevClose) * 100,
      volume: s.volume,
      open: s.open,
      high: s.high,
      low: s.low,
      prevClose: s.prevClose,
      bid: s.last - spread,
      bidSize: Math.round(100 + Math.random() * 900),
      ask: s.last + spread,
      askSize: Math.round(100 + Math.random() * 900),
      halted: s.halted,
      session: getMarketSession(),
    }
  }

  getChart(symbol: string, interval: "1m" | "5m" | "1d", count: number): Candle[] {
    const s = this.symbols.get(symbol)
    if (!s) return []
    const stepMs = interval === "1m" ? 60000 : interval === "5m" ? 300000 : 86400000
    const vol = interval === "1d" ? 0.025 : 0.004
    const candles: Candle[] = []
    let price = s.last
    // walk backwards from current price
    const rev: Candle[] = []
    for (let i = 0; i < count; i++) {
      const c = price
      const o = c * (1 + (Math.random() - 0.5) * vol)
      const h = Math.max(o, c) * (1 + Math.random() * vol * 0.6)
      const l = Math.min(o, c) * (1 - Math.random() * vol * 0.6)
      rev.push({
        t: new Date(Date.now() - i * stepMs).toISOString(),
        o,
        h,
        l,
        c,
        v: Math.round(50_000 + Math.random() * 400_000),
      })
      price = o * (1 + (Math.random() - 0.5) * vol * 0.8)
    }
    for (let i = rev.length - 1; i >= 0; i--) candles.push(rev[i])
    return candles
  }

  getEquityCurve(days = 30) {
    const points = []
    let eq = this.totalEquityUsd() * 0.88
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000)
      eq = i === 0 ? this.totalEquityUsd() : eq * (1 + (Math.random() - 0.44) * 0.02)
      points.push({ date: d.toISOString().slice(0, 10), equityUsd: eq })
    }
    return points
  }

  getSymbols(): SymbolInfo[] {
    return Array.from(this.symbols.values()).map(({ symbol, name, exch }) => ({ symbol, name, exch }))
  }

  getOrders(status: "open" | "filled" | "all"): Order[] {
    const sorted = [...this.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (status === "open") return sorted.filter((o) => o.status === "open" || o.status === "partial")
    if (status === "filled") return sorted.filter((o) => o.status === "filled" || o.status === "partial")
    return sorted
  }

  getRiskLimits(): RiskLimits {
    return {
      ...this.riskLimits,
      usage: {
        ...this.riskUsage,
        openPositions: this.positions.length,
      },
    }
  }

  getSystemStatus(): SystemStatus {
    return {
      ws: this.wsStatus,
      apiUsagePct: Math.round(this.apiUsagePct),
      kisTokenExpiresAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
      killSwitchActive: this.killSwitchActive,
      marketSession: getMarketSession(),
      nextSessionStartEt: "09:30 ET",
    }
  }

  getStrategies(): Strategy[] {
    return this.strategies.map((s) => ({ ...s, config: { ...s.config } }))
  }

  getLogs(id: string, limit: number): StrategyLog[] {
    if (!this.logCache.has(id)) {
      const st = this.strategies.find((s) => s.id === id)
      const logs: StrategyLog[] = []
      const templates: Array<[StrategyLog["level"], string, Record<string, unknown> | undefined]> = [
        ["INFO", "RSI=27.3 < 30 → 매수 시그널", { symbol: "GME", rsi: 27.3, threshold: 30 }],
        ["INFO", "매수 주문 제출: GME 10주 @ $22.07 (지정가)", { orderId: "ord-102" }],
        ["INFO", "체결 확인: GME 10주 @ $22.07", { orderId: "ord-102" }],
        ["WARN", "슬리피지 0.4% 감지 — 허용 한도 0.5% 이내", { slippagePct: 0.4 }],
        ["INFO", "RSI=56.1 > 55 → 청산 시그널", { symbol: "MARA", rsi: 56.1 }],
        ["ERROR", "주문 거부: 종목당 최대금액 초과", { symbol: "COIN", limitUsd: 1500 }],
        ["INFO", "포지션 점검 완료 — 손절/익절 조건 미충족", undefined],
        ["WARN", "KIS API 응답 지연 1,240ms", { latencyMs: 1240 }],
        ["INFO", "전일 고가 돌파 감시 시작", { symbol: "NVDA" }],
        ["INFO", `전략 시작됨: ${st?.name ?? id}`, undefined],
      ]
      for (let i = 0; i < 40; i++) {
        const [level, message, context] = templates[i % templates.length]
        logs.push({ ts: isoMinusMin(i * 7 + Math.floor(Math.random() * 5)), level, message, context })
      }
      this.logCache.set(id, logs)
    }
    return this.logCache.get(id)!.slice(0, limit)
  }

  // ---- mutations -----------------------------------------------------------

  placeOrder(req: OrderRequest): { ok: true; orderId: string } | { ok: false; error: string } {
    const s = this.symbols.get(req.symbol)
    if (!s) return { ok: false, error: "알 수 없는 종목입니다." }
    if (s.halted) return { ok: false, error: `거래정지 종목입니다: ${req.symbol}` }
    if (!Number.isInteger(req.qty) || req.qty <= 0) return { ok: false, error: "수량은 1주 이상의 정수여야 합니다." }
    const price = req.orderType === "market" ? s.last : (req.price ?? 0)
    const amount = price * req.qty
    if (amount > this.riskLimits.maxOrderAmountUsd) {
      return { ok: false, error: `리스크 한도 초과: 1회 최대 주문금액 $${this.riskLimits.maxOrderAmountUsd.toLocaleString()} (요청 $${amount.toFixed(2)})` }
    }
    if (req.side === "buy" && amount > this.cashUsd) {
      return { ok: false, error: "예수금이 부족합니다." }
    }
    if (req.side === "sell") {
      const pos = this.positions.find((p) => p.symbol === req.symbol)
      if (!pos || pos.qty < req.qty) return { ok: false, error: "보유 수량이 부족합니다." }
    }
    const orderId = `ord-${this.orderSeq++}`
    const order: Order = {
      orderId,
      symbol: req.symbol,
      name: s.name,
      exch: s.exch,
      side: req.side,
      orderType: req.orderType,
      session: req.session,
      qty: req.qty,
      filledQty: 0,
      price: req.orderType === "market" ? s.last : (req.price ?? s.last),
      avgFillPrice: 0,
      status: "open",
      createdAt: nowIso(),
    }
    this.orders.push(order)
    this.riskUsage.orderAmountTodayUsd += amount
    if (req.orderType === "market") {
      // fill shortly after acceptance
      setTimeout(() => this.fillOrder(orderId), 900)
    }
    return { ok: true, orderId }
  }

  private fillOrder(orderId: string) {
    const order = this.orders.find((o) => o.orderId === orderId)
    if (!order || order.status !== "open") return
    const s = this.symbols.get(order.symbol)!
    const fillPrice = order.orderType === "market" ? s.last : order.price
    order.filledQty = order.qty
    order.avgFillPrice = fillPrice
    order.status = "filled"
    // apply to positions/cash
    const pos = this.positions.find((p) => p.symbol === order.symbol)
    if (order.side === "buy") {
      this.cashUsd -= fillPrice * order.qty
      if (pos) {
        pos.avgPrice = (pos.avgPrice * pos.qty + fillPrice * order.qty) / (pos.qty + order.qty)
        pos.qty += order.qty
      } else {
        this.positions.push({ symbol: order.symbol, qty: order.qty, avgPrice: fillPrice })
      }
    } else {
      this.cashUsd += fillPrice * order.qty
      if (pos) {
        pos.qty -= order.qty
        if (pos.qty <= 0) this.positions = this.positions.filter((p) => p.symbol !== order.symbol)
      }
    }
    this.emit({
      ch: "execution",
      data: { orderId, symbol: order.symbol, side: order.side, qty: order.qty, price: fillPrice, ts: nowIso() },
    })
    this.emit({ ch: "position", data: this.getPositions() })
  }

  cancelOrder(orderId: string): boolean {
    const order = this.orders.find((o) => o.orderId === orderId)
    if (!order || (order.status !== "open" && order.status !== "partial")) return false
    order.status = "cancelled"
    return true
  }

  setStrategyStatus(id: string, status: "running" | "stopped"): boolean {
    const st = this.strategies.find((s) => s.id === id)
    if (!st) return false
    if (status === "running" && this.killSwitchActive) return false
    st.status = status
    return true
  }

  patchStrategyConfig(id: string, config: Partial<Strategy["config"]>): boolean {
    const st = this.strategies.find((s) => s.id === id)
    if (!st) return false
    st.config = { ...st.config, ...config }
    return true
  }

  patchRiskLimits(patch: Partial<typeof this.riskLimits>): void {
    this.riskLimits = { ...this.riskLimits, ...patch }
  }

  activateKillSwitch(): string[] {
    this.killSwitchActive = true
    const stopped: string[] = []
    for (const st of this.strategies) {
      if (st.status === "running") {
        st.status = "stopped"
        stopped.push(st.id)
      }
    }
    return stopped
  }

  deactivateKillSwitch(): void {
    this.killSwitchActive = false
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __mockEngine: MockEngine | undefined
}

/** HMR-safe singleton */
export function getEngine(): MockEngine {
  if (!globalThis.__mockEngine) {
    globalThis.__mockEngine = new MockEngine()
  }
  return globalThis.__mockEngine
}
