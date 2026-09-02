import type {
  PipelineEdge,
  PipelineLogLine,
  PipelineNode,
  PipelineNodeDetail,
  PipelineNodeMetrics,
  PipelineSnapshot,
  PipelineStage,
  ScoredNews,
  SentimentLabel,
  SentimentOverview,
  SymbolSentiment,
} from "@/lib/types"

/**
 * 파이프라인/감성 목 시뮬레이터 — 백엔드 pipeline/engine.ts와 동일한 계산을
 * 브라우저에서 수행한다 (RSI/변동성/알파/앙상블/렉시콘 채점 전부 실계산,
 * 레이턴시는 performance.now() 실측). 응답 형태는 백엔드 REST와 동일.
 */

// ===== DAG 정의 (백엔드 NODE_DEFS와 동일) =====

interface NodeDef {
  id: string
  stage: PipelineStage
  name: string
  description: string
  codeHint: string
}

const NODE_DEFS: NodeDef[] = [
  {
    id: "tick-data",
    stage: "ingestion",
    name: "시세 틱",
    description: "정형 소스 — KIS 실시간 체결/호가 틱. MOCK 모드에서는 랜덤워크 시뮬레이터가 같은 형태로 공급한다.",
    codeHint: `state.on("tick", (q) => pipeline.onTick(q))`,
  },
  {
    id: "news-stream",
    stage: "ingestion",
    name: "뉴스 스트림",
    description: "비정형 소스 — Google News RSS 헤드라인 (키 불필요). 실패/MOCK 시 합성 헤드라인 폴백, source 필드로 구분.",
    codeHint: `newsIngestor.on("news", (items) => pipeline.onNews(items))`,
  },
  {
    id: "technical",
    stage: "features",
    name: "기술적 지표",
    description: "틱 히스토리에서 RSI(14), 20틱 모멘텀, 수익률 표준편차(변동성)를 계산한다.",
    codeHint: `rsi14(prices); stdev(logReturns) * 100`,
  },
  {
    id: "microstructure",
    stage: "features",
    name: "마이크로구조",
    description: "호가 스프레드(bps), 주문흐름 불균형 (bidSize-askSize)/(bidSize+askSize), 거래량 증분.",
    codeHint: `(q.ask - q.bid) / q.last * 10_000`,
  },
  {
    id: "sentiment-score",
    stage: "features",
    name: "감성 점수",
    description: "사전(lexicon) 기반 헤드라인 채점 → 심볼별 신뢰도 가중 EMA. 기여 단어가 evidence로 남는다.",
    codeHint: `tracker.ingest(item) // scoreHeadline + EMA`,
  },
  {
    id: "alpha-technical",
    stage: "models",
    name: "기술 알파",
    description: "RSI 평균회귀 + 모멘텀 + 주문흐름의 tanh 앙상블 → [-1,1] 알파. 변동성이 높을수록 신뢰도 하향.",
    codeHint: `tanh(0.6*rsiSig + 0.3*mom + 0.3*flow)`,
  },
  {
    id: "alpha-sentiment",
    stage: "models",
    name: "감성 알파",
    description: "심볼 감성 EMA를 알파로 사용. 멘션 수가 적으면 신뢰도 하향.",
    codeHint: `alpha = sent.score; conf = min(1, mentions/5)`,
  },
  {
    id: "alpha-ensemble",
    stage: "models",
    name: "알파 앙상블",
    description: "기술 알파와 감성 알파를 신뢰도 가중 블렌딩. 알파 변화율로 안정성 지표를 갱신한다.",
    codeHint: `(aT*cT + aS*cS) / (cT + cS)`,
  },
  {
    id: "portfolio",
    stage: "strategy",
    name: "포트폴리오 구성",
    description: "양(+)의 앙상블 알파에 비례한 목표 비중(리스크 한도 캡) vs 현재 보유 비중의 괴리를 계산한다.",
    codeHint: `target = alpha+ / Σalpha+ * cap`,
  },
  {
    id: "execution-router",
    stage: "execution",
    name: "실행 라우터",
    description:
      "비중 괴리가 임계치를 넘으면 매수/매도 신호를 만든다. 신호는 반드시 riskManager 관문을 통과해야 하며, 여기서는 신호까지만 — 실제 주문 발행은 주문 경로의 몫.",
    codeHint: `if (|drift| > 3%) signal(); riskManager.check(...)`,
  },
]

const EDGES: PipelineEdge[] = [
  { from: "tick-data", to: "technical" },
  { from: "tick-data", to: "microstructure" },
  { from: "news-stream", to: "sentiment-score" },
  { from: "technical", to: "alpha-technical" },
  { from: "microstructure", to: "alpha-technical" },
  { from: "sentiment-score", to: "alpha-sentiment" },
  { from: "alpha-technical", to: "alpha-ensemble" },
  { from: "alpha-sentiment", to: "alpha-ensemble" },
  { from: "alpha-ensemble", to: "portfolio" },
  { from: "portfolio", to: "execution-router" },
]

const STAGES: PipelineStage[] = ["ingestion", "features", "models", "strategy", "execution"]

// ===== 렉시콘 채점 (백엔드 sentiment/scorer.ts와 동일 로직) =====

const POSITIVE: Record<string, number> = {
  beat: 2, beats: 2, surge: 2, surges: 2, soar: 2, soars: 2, rally: 2, record: 1,
  upgrade: 2, upgraded: 2, outperform: 2, bullish: 2, buy: 1, growth: 1, strong: 1,
  gain: 1, gains: 1, jump: 2, jumps: 2, rise: 1, rises: 1, up: 1, profit: 1,
  raise: 1, raises: 1, wins: 1, approval: 1, partnership: 1, expands: 1, momentum: 1,
  demand: 1, tops: 2, exceeds: 2, boom: 2,
}
const NEGATIVE: Record<string, number> = {
  miss: 2, misses: 2, plunge: 2, plunges: 2, crash: 2, downgrade: 2, downgraded: 2,
  bearish: 2, sell: 1, selloff: 2, weak: 1, fall: 1, falls: 1, drop: 1, drops: 1,
  down: 1, loss: 1, losses: 1, cut: 1, cuts: 1, layoffs: 2, lawsuit: 2, probe: 2,
  investigation: 2, recall: 2, fined: 2, warning: 1, warns: 1, delay: 1, delays: 1,
  concern: 1, concerns: 1, risk: 1, risks: 1, slump: 2, halted: 1, fraud: 2,
  tumbles: 2, sinks: 2, slides: 1,
}
const NEGATORS = new Set(["not", "no", "never", "without", "fails", "fail"])

function scoreHeadline(text: string): { score: number; confidence: number; hits: string[] } {
  const tokens = text.toLowerCase().replace(/[^a-z0-9'\s%-]/g, " ").split(/\s+/).filter(Boolean)
  let raw = 0
  let weightAbs = 0
  const hits: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    let w = 0
    if (t in POSITIVE) w = POSITIVE[t]
    else if (t in NEGATIVE) w = -NEGATIVE[t]
    if (w === 0) continue
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (NEGATORS.has(tokens[j])) {
        w = -w
        break
      }
    }
    raw += w
    weightAbs += Math.abs(w)
    hits.push(t)
  }
  if (weightAbs === 0) return { score: 0, confidence: 0, hits: [] }
  return { score: +Math.tanh(raw / 3).toFixed(3), confidence: +Math.min(1, weightAbs / 4).toFixed(2), hits }
}

function labelOf(score: number): SentimentLabel {
  if (score > 0.15) return "BULLISH"
  if (score < -0.15) return "BEARISH"
  return "NEUTRAL"
}

function assessmentOf(symbol: string, score: number, confidence: number): string {
  const label = labelOf(score)
  if (label === "BULLISH")
    return confidence > 0.6 ? `${symbol} 강한 긍정 신호 — 감성 알파 가중치 상향 반영` : `${symbol} 완만한 긍정 — 추세 확인 대기`
  if (label === "BEARISH")
    return confidence > 0.6 ? `${symbol} 강한 부정 신호 — 노출 축소 검토` : `${symbol} 단기 역풍 가능성 — 모니터링 지속`
  return `${symbol} 중립 — 알파 기여 없음`
}

const MOCK_HEADLINES: Array<[string, string]> = [
  ["{sym} shares surge after earnings beat expectations", "MockWire"],
  ["{sym} falls as analysts cut price target on margin concerns", "MockWire"],
  ["{sym} announces record quarterly revenue growth", "MockDaily"],
  ["Regulators open probe into {sym} business practices", "MockDaily"],
  ["{sym} upgraded to buy at MockBank on strong demand", "MockBank"],
  ["{sym} warns of supply delays, shares drop", "MockWire"],
  ["{sym} expands partnership, momentum builds", "MockDaily"],
  ["{sym} misses on revenue, stock slides in after hours", "MockWire"],
]

// ===== 계산 유틸 =====

function rsi14(prices: number[]): number {
  const period = 14
  const slice = prices.slice(-(period + 1))
  if (slice.length < period + 1) return 50
  let gains = 0
  let losses = 0
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1]
    if (d > 0) gains += d
    else losses -= d
  }
  if (losses === 0) return 100
  const rs = gains / period / (losses / period)
  return 100 - 100 / (1 + rs)
}

function stdevPct(prices: number[]): number {
  if (prices.length < 3) return 0
  const rets: number[] = []
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]))
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const varr = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length
  return Math.sqrt(varr) * 100
}

// ===== 노드 런타임 (레이턴시/처리량 실측) =====

const SAMPLE_MAX = 30
const LOG_MAX = 300
const IDLE_AFTER_MS = 20_000

class NodeRuntime {
  def: NodeDef
  totalMsgs = 0
  lastLatencyMs = 0
  avgLatencyMs = 0
  lastRunAt: number | null = null
  private recentTs: number[] = []
  sampleColumns: string[] = []
  sampleRows: Array<Array<string | number>> = []

  constructor(def: NodeDef) {
    this.def = def
  }

  run<T>(fn: () => T): T {
    const t0 = performance.now()
    const out = fn()
    const latency = performance.now() - t0
    this.lastLatencyMs = latency
    this.avgLatencyMs = this.avgLatencyMs === 0 ? latency : this.avgLatencyMs * 0.9 + latency * 0.1
    this.totalMsgs += 1
    const now = Date.now()
    this.lastRunAt = now
    this.recentTs.push(now)
    const cutoff = now - 10_000
    while (this.recentTs.length > 0 && this.recentTs[0] < cutoff) this.recentTs.shift()
    return out
  }

  pushSample(columns: string[], row: Array<string | number>) {
    this.sampleColumns = columns
    this.sampleRows.unshift(row)
    if (this.sampleRows.length > SAMPLE_MAX) this.sampleRows.length = SAMPLE_MAX
  }

  metrics(): PipelineNodeMetrics {
    const now = Date.now()
    return {
      status: this.lastRunAt !== null && now - this.lastRunAt < IDLE_AFTER_MS ? "active" : "idle",
      lastLatencyMs: +this.lastLatencyMs.toFixed(3),
      avgLatencyMs: +this.avgLatencyMs.toFixed(3),
      throughputPerSec: +(this.recentTs.length / 10).toFixed(2),
      totalMsgs: this.totalMsgs,
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      lastError: null,
    }
  }
}

// ===== 시뮬레이터 본체 =====

export interface TickInput {
  symbol: string
  last: number
  bid: number
  ask: number
  bidSize: number
  askSize: number
  volume: number
}

export interface RiskGate {
  maxSymbolWeightPct: number
  check: (p: { amountUsd: number; side: "buy" | "sell"; resultingSymbolWeightPct: number }) => string | null
  currentWeightPct: (symbol: string) => number
  totalEquityUsd: () => number
}

interface SymSentiment {
  score: number
  mentions: number
  topDriver: string | null
  updatedAt: string | null
}

export class PipelineSim {
  private nodes = new Map<string, NodeRuntime>()
  private prices = new Map<string, number[]>()
  private lastVolume = new Map<string, number>()
  private techAlpha = new Map<string, { alpha: number; confidence: number }>()
  private sentAlpha = new Map<string, { alpha: number; confidence: number }>()
  private ensemble = new Map<string, { alpha: number; confidence: number }>()
  private prevEnsemble = new Map<string, number>()
  private sentiments = new Map<string, SymSentiment>()
  private sourceCounts = new Map<string, number>()
  private signalCooldown = new Map<string, number>()
  private tickCount = 0
  private newsSeq = 0
  alphaStability = 1
  logs: PipelineLogLine[] = []
  feed: ScoredNews[] = []
  onLog: ((line: PipelineLogLine) => void) | null = null
  onNews: ((scored: ScoredNews[]) => void) | null = null
  /** 실행 신호 — 자동매매 실행기(목엔진)가 구독한다 */
  onSignal: ((sig: { symbol: string; side: "buy" | "sell"; strengthPct: number; reason: string; blocked: string | null }) => void) | null = null

  constructor(
    private trackedSymbols: string[],
    private risk: RiskGate,
  ) {
    for (const def of NODE_DEFS) this.nodes.set(def.id, new NodeRuntime(def))
    for (const s of trackedSymbols) this.sentiments.set(s, { score: 0, mentions: 0, topDriver: null, updatedAt: null })
    this.log("pipeline", `파이프라인 기동 — ${NODE_DEFS.length}개 노드, 추적 심볼 ${trackedSymbols.length}개`)
  }

  onTick(t: TickInput) {
    const ts = new Date().toISOString()
    const short = ts.slice(11, 19)

    const ingest = this.nodes.get("tick-data")!
    ingest.run(() => {
      const arr = this.prices.get(t.symbol) ?? []
      arr.push(t.last)
      if (arr.length > 300) arr.shift()
      this.prices.set(t.symbol, arr)
    })
    ingest.pushSample(["ts", "symbol", "last", "bid", "ask", "volume"], [short, t.symbol, +t.last.toFixed(2), +t.bid.toFixed(2), +t.ask.toFixed(2), t.volume])

    const techNode = this.nodes.get("technical")!
    const tech = techNode.run(() => {
      const arr = this.prices.get(t.symbol)!
      const mom = arr.length > 20 ? ((arr[arr.length - 1] - arr[arr.length - 21]) / arr[arr.length - 21]) * 100 : 0
      return { rsi14: +rsi14(arr).toFixed(1), momentumPct: +mom.toFixed(3), volatilityPct: +stdevPct(arr.slice(-60)).toFixed(4) }
    })
    techNode.pushSample(["ts", "symbol", "rsi14", "momentum%", "vol%"], [short, t.symbol, tech.rsi14, tech.momentumPct, tech.volatilityPct])

    const microNode = this.nodes.get("microstructure")!
    const micro = microNode.run(() => {
      const spreadBps = t.last > 0 ? ((t.ask - t.bid) / t.last) * 10_000 : 0
      const denom = t.bidSize + t.askSize
      const ofi = denom > 0 ? (t.bidSize - t.askSize) / denom : 0
      const prevVol = this.lastVolume.get(t.symbol) ?? t.volume
      this.lastVolume.set(t.symbol, t.volume)
      return { spreadBps: +spreadBps.toFixed(2), ofi: +ofi.toFixed(3), volumeDelta: t.volume - prevVol }
    })
    microNode.pushSample(["ts", "symbol", "spreadBps", "ofi", "Δvol"], [short, t.symbol, micro.spreadBps, micro.ofi, micro.volumeDelta])

    const aTechNode = this.nodes.get("alpha-technical")!
    const aTech = aTechNode.run(() => {
      const rsiSig = (50 - tech.rsi14) / 50
      const momSig = Math.tanh(tech.momentumPct / 2)
      const alpha = Math.tanh(0.6 * rsiSig + 0.3 * momSig + 0.3 * micro.ofi)
      const conf = Math.max(0.1, 1 - Math.min(1, tech.volatilityPct * 2))
      return { alpha: +alpha.toFixed(3), confidence: +conf.toFixed(2) }
    })
    this.techAlpha.set(t.symbol, aTech)
    aTechNode.pushSample(["ts", "symbol", "alpha", "conf"], [short, t.symbol, aTech.alpha, aTech.confidence])

    this.recomputeEnsemble(t.symbol, short)
    this.recomputePortfolio(short)

    // 주기적 합성 뉴스 (약 15틱마다 1건)
    this.tickCount++
    if (this.tickCount % 15 === 0) this.emitMockNews()
  }

  private emitMockNews() {
    const symbol = this.trackedSymbols[Math.floor(Math.random() * this.trackedSymbols.length)]
    const [tpl, source] = MOCK_HEADLINES[Math.floor(Math.random() * MOCK_HEADLINES.length)]
    const title = tpl.replace("{sym}", symbol)
    const now = new Date().toISOString()
    const short = now.slice(11, 19)

    const streamNode = this.nodes.get("news-stream")!
    streamNode.run(() => 1)
    streamNode.pushSample(["ts", "symbol", "source", "title"], [short, symbol, source, title.slice(0, 80)])

    const scoreNode = this.nodes.get("sentiment-score")!
    const scored = scoreNode.run(() => {
      const { score, confidence, hits } = scoreHeadline(title)
      const s = this.sentiments.get(symbol) ?? { score: 0, mentions: 0, topDriver: null, updatedAt: null }
      if (confidence > 0) {
        const a = 0.3 * confidence
        s.score = +(s.score * (1 - a) + score * a).toFixed(3)
      }
      s.mentions += 1
      if (Math.abs(score) > 0.1) s.topDriver = title
      s.updatedAt = now
      this.sentiments.set(symbol, s)
      this.sourceCounts.set(source, (this.sourceCounts.get(source) ?? 0) + 1)
      const item: ScoredNews = {
        id: `news-${this.newsSeq++}`,
        symbol,
        title,
        source,
        url: null,
        publishedAt: now,
        fetchedAt: now,
        score,
        confidence,
        label: labelOf(score),
        evidence: hits,
        assessment: assessmentOf(symbol, score, confidence),
      }
      return item
    })
    scoreNode.pushSample(["ts", "symbol", "score", "conf", "label"], [short, symbol, scored.score, scored.confidence, scored.label])
    this.feed.unshift(scored)
    if (this.feed.length > 150) this.feed.length = 150
    if (Math.abs(scored.score) > 0.15) {
      this.log(
        "sentiment-score",
        `${symbol} ${scored.label} ${scored.score >= 0 ? "+" : ""}${scored.score} — "${scored.title.slice(0, 70)}" [${scored.evidence.join(", ")}]`,
      )
    }

    const aSentNode = this.nodes.get("alpha-sentiment")!
    const aSent = aSentNode.run(() => {
      const s = this.sentiments.get(symbol)!
      return { alpha: s.score, confidence: +Math.min(1, s.mentions / 5).toFixed(2) }
    })
    this.sentAlpha.set(symbol, aSent)
    aSentNode.pushSample(["ts", "symbol", "alpha", "conf", "mentions"], [short, symbol, aSent.alpha, aSent.confidence, this.sentiments.get(symbol)!.mentions])
    this.recomputeEnsemble(symbol, short)

    this.onNews?.([scored])
  }

  private recomputeEnsemble(symbol: string, short: string) {
    const node = this.nodes.get("alpha-ensemble")!
    const blended = node.run(() => {
      const t = this.techAlpha.get(symbol)
      const s = this.sentAlpha.get(symbol)
      const wT = t ? t.confidence : 0
      const wS = s ? s.confidence : 0
      const denom = wT + wS
      if (denom === 0) return null
      return {
        alpha: +(((t?.alpha ?? 0) * wT + (s?.alpha ?? 0) * wS) / denom).toFixed(3),
        confidence: +Math.min(1, denom).toFixed(2),
      }
    })
    if (!blended) return
    const prev = this.prevEnsemble.get(symbol)
    if (prev !== undefined) {
      const delta = Math.abs(blended.alpha - prev)
      this.alphaStability = +(this.alphaStability * 0.98 + (1 - Math.min(1, delta * 5)) * 0.02).toFixed(3)
    }
    this.prevEnsemble.set(symbol, blended.alpha)
    this.ensemble.set(symbol, blended)
    node.pushSample(["ts", "symbol", "alpha", "conf"], [short, symbol, blended.alpha, blended.confidence])
  }

  private recomputePortfolio(short: string) {
    const pfNode = this.nodes.get("portfolio")!
    const targets = pfNode.run(() => {
      const alphas = [...this.ensemble.entries()].map(([symbol, a]) => ({ symbol, ...a }))
      const positive = alphas.filter((a) => a.alpha > 0.05)
      const sumPos = positive.reduce((acc, a) => acc + a.alpha, 0)
      const cap = this.risk.maxSymbolWeightPct
      return alphas
        .map((a) => {
          const cur = this.risk.currentWeightPct(a.symbol)
          const target = a.alpha > 0.05 && sumPos > 0 ? Math.min(cap, (a.alpha / sumPos) * Math.min(100, cap * positive.length)) : 0
          return { symbol: a.symbol, alpha: a.alpha, targetWeightPct: +target.toFixed(1), currentWeightPct: +cur.toFixed(1), driftPct: +(target - cur).toFixed(1) }
        })
        .sort((a, b) => b.alpha - a.alpha)
    })
    const top = targets[0]
    if (top) pfNode.pushSample(["ts", "symbol", "alpha", "target%", "cur%", "drift%"], [short, top.symbol, top.alpha, top.targetWeightPct, top.currentWeightPct, top.driftPct])

    const exNode = this.nodes.get("execution-router")!
    exNode.run(() => {
      const now = Date.now()
      for (const t of targets) {
        if (Math.abs(t.driftPct) < 3) continue
        const last = this.signalCooldown.get(t.symbol) ?? 0
        if (now - last < 5 * 60_000) continue
        this.signalCooldown.set(t.symbol, now)
        const side: "buy" | "sell" = t.driftPct > 0 ? "buy" : "sell"
        const amountUsd = (Math.abs(t.driftPct) / 100) * this.risk.totalEquityUsd()
        const blocked = this.risk.check({ amountUsd, side, resultingSymbolWeightPct: t.targetWeightPct })
        exNode.pushSample(["ts", "symbol", "side", "strength%", "risk"], [short, t.symbol, side, Math.abs(t.driftPct), blocked ?? "PASS"])
        const reason = `앙상블 알파 ${t.alpha >= 0 ? "+" : ""}${t.alpha}, 비중 괴리 ${t.driftPct}%p`
        this.log(
          "execution-router",
          blocked
            ? `${t.symbol} ${side.toUpperCase()} 신호 차단 — ${blocked}`
            : `${t.symbol} ${side.toUpperCase()} 신호 (${Math.abs(t.driftPct).toFixed(1)}%p) — ${reason}`,
        )
        this.onSignal?.({ symbol: t.symbol, side, strengthPct: Math.abs(t.driftPct), reason, blocked })
      }
    })
  }

  log(node: string, message: string) {
    const line: PipelineLogLine = { ts: new Date().toISOString(), node, message }
    this.logs.unshift(line)
    if (this.logs.length > LOG_MAX) this.logs.length = LOG_MAX
    this.onLog?.(line)
  }

  // ===== 조회 (백엔드 REST와 동일 형태) =====

  snapshot(): PipelineSnapshot {
    const nodes: PipelineNode[] = [...this.nodes.values()].map((n) => ({ ...n.def, metrics: n.metrics() }))
    const active = nodes.filter((n) => n.metrics.status === "active").length
    const latency = nodes.reduce((acc, n) => acc + n.metrics.avgLatencyMs, 0)
    return {
      status: "active",
      latencyMs: +latency.toFixed(2),
      nodesActive: active,
      nodesTotal: nodes.length,
      alphaStability: this.alphaStability,
      stages: STAGES,
      nodes,
      edges: EDGES,
    }
  }

  nodeDetail(id: string): PipelineNodeDetail | null {
    const n = this.nodes.get(id)
    if (!n) return null
    return { ...n.def, metrics: n.metrics(), sample: { columns: n.sampleColumns, rows: n.sampleRows } }
  }

  sentimentOverview(): SentimentOverview {
    const symbols: SymbolSentiment[] = [...this.sentiments.entries()]
      .map(([symbol, s]) => ({ symbol, score: s.score, label: labelOf(s.score), mentions: s.mentions, topDriver: s.topDriver, updatedAt: s.updatedAt }))
      .sort((a, b) => b.score - a.score)
    let num = 0
    let den = 0
    for (const s of symbols) {
      const w = Math.min(10, s.mentions)
      num += s.score * w
      den += w
    }
    const index = den > 0 ? +(num / den).toFixed(3) : 0
    return {
      index,
      label: labelOf(index),
      totalMentions: symbols.reduce((acc, s) => acc + s.mentions, 0),
      symbols,
      sources: [...this.sourceCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    }
  }
}
