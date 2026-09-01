import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { Quote } from "../kis/types.js";
import type {
  AlphaValue,
  ExecutionSignal,
  MicrostructureFeatures,
  NodeMetrics,
  PipelineEdge,
  PipelineLogLine,
  PipelineNodeDef,
  PipelineNodeDetail,
  PipelineNodeSummary,
  PipelineSnapshot,
  PortfolioTarget,
  TechnicalFeatures,
} from "./types.js";
import { SentimentTracker, type ScoredNewsItem } from "../sentiment/tracker.js";
import type { NewsItem } from "../sentiment/news.js";
import { state } from "../api/state.js";
import { riskManager } from "../risk/riskManager.js";

/**
 * 실시간 데이터/ML 파이프라인 엔진.
 * 정형(시세 틱) + 비정형(뉴스) 소스를 하나의 DAG로 처리한다:
 *   INGESTION → FEATURES → MODELS → STRATEGY → EXECUTION
 * 모든 지표(레이턴시/처리량)는 performance.now() 실측값이다.
 * 실행 단계는 "신호"까지만 만든다 — 실제 주문은 기존 리스크 관문/주문 경로 소관.
 */

// ===== DAG 정의 =====

export const NODE_DEFS: PipelineNodeDef[] = [
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
      "비중 괴리가 임계치를 넘으면 매수/매도 신호를 만든다. 신호는 반드시 riskManager 관문을 통과해야 하며, 여기서는 신호까지만 — 실제 주문 발행은 주문 경로(kisClient)의 몫.",
    codeHint: `if (|drift| > 3%) signal(); riskManager.check(...)`,
  },
];

export const EDGES: PipelineEdge[] = [
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
];

const STAGES: PipelineSnapshot["stages"] = ["ingestion", "features", "models", "strategy", "execution"];

// ===== 노드 런타임 =====

const SAMPLE_MAX = 30;
const LOG_MAX = 300;
const IDLE_AFTER_MS = 20_000;

class NodeRuntime {
  def: PipelineNodeDef;
  totalMsgs = 0;
  lastLatencyMs = 0;
  avgLatencyMs = 0;
  lastRunAt: number | null = null;
  lastError: string | null = null;
  /** 최근 10초 타임스탬프 (처리량 계산용) */
  private recentTs: number[] = [];
  sampleColumns: string[] = [];
  sampleRows: Array<Array<string | number>> = [];

  constructor(def: PipelineNodeDef) {
    this.def = def;
  }

  /** fn 실행을 계측한다 — 레이턴시/처리량은 전부 여기서 실측 */
  run<T>(fn: () => T): T {
    const t0 = performance.now();
    try {
      const out = fn();
      this.record(performance.now() - t0);
      return out;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.record(performance.now() - t0);
      throw e;
    }
  }

  private record(latencyMs: number) {
    this.lastLatencyMs = latencyMs;
    this.avgLatencyMs = this.avgLatencyMs === 0 ? latencyMs : this.avgLatencyMs * 0.9 + latencyMs * 0.1;
    this.totalMsgs += 1;
    const now = Date.now();
    this.lastRunAt = now;
    this.recentTs.push(now);
    const cutoff = now - 10_000;
    while (this.recentTs.length > 0 && this.recentTs[0] < cutoff) this.recentTs.shift();
  }

  pushSample(columns: string[], row: Array<string | number>) {
    this.sampleColumns = columns;
    this.sampleRows.unshift(row);
    if (this.sampleRows.length > SAMPLE_MAX) this.sampleRows.length = SAMPLE_MAX;
  }

  metrics(): NodeMetrics {
    const now = Date.now();
    return {
      status: this.lastError
        ? "error"
        : this.lastRunAt !== null && now - this.lastRunAt < IDLE_AFTER_MS
          ? "active"
          : "idle",
      lastLatencyMs: +this.lastLatencyMs.toFixed(3),
      avgLatencyMs: +this.avgLatencyMs.toFixed(3),
      throughputPerSec: +(this.recentTs.length / 10).toFixed(2),
      totalMsgs: this.totalMsgs,
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      lastError: this.lastError,
    };
  }
}

// ===== 순수 계산 함수 =====

export function rsi14(prices: number[]): number {
  const period = 14;
  const slice = prices.slice(-(period + 1));
  if (slice.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

function stdevPct(prices: number[]): number {
  if (prices.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr) * 100;
}

// ===== 엔진 =====

export class PipelineEngine extends EventEmitter {
  nodes = new Map<string, NodeRuntime>();
  tracker = new SentimentTracker();
  status: "active" | "stopped" = "stopped";

  private prices = new Map<string, number[]>();
  private lastVolume = new Map<string, number>();
  private techFeatures = new Map<string, TechnicalFeatures>();
  private microFeatures = new Map<string, MicrostructureFeatures>();
  private techAlpha = new Map<string, AlphaValue>();
  private sentAlpha = new Map<string, AlphaValue>();
  private ensembleAlpha = new Map<string, AlphaValue>();
  private prevEnsemble = new Map<string, number>();
  /** 1 - mean|Δalpha| 의 EMA */
  alphaStability = 1;

  portfolioTargets: PortfolioTarget[] = [];
  signals: ExecutionSignal[] = [];
  logs: PipelineLogLine[] = [];

  private lastSnapshotEmit = 0;
  private startedAt: string | null = null;

  constructor() {
    super();
    for (const def of NODE_DEFS) this.nodes.set(def.id, new NodeRuntime(def));
  }

  start(trackedSymbols: string[]) {
    this.status = "active";
    this.startedAt = new Date().toISOString();
    for (const s of trackedSymbols) this.tracker.track(s);
    this.log("pipeline", `파이프라인 기동 — ${NODE_DEFS.length}개 노드, 추적 심볼 ${trackedSymbols.length}개`);
  }

  // ---- 정형 레인: 시세 틱 ----

  onTick(q: Quote) {
    if (this.status !== "active") return;
    const ts = new Date().toISOString();

    // INGESTION: tick-data
    const ingest = this.nodes.get("tick-data")!;
    ingest.run(() => {
      const arr = this.prices.get(q.symbol) ?? [];
      arr.push(q.last);
      if (arr.length > 300) arr.shift();
      this.prices.set(q.symbol, arr);
    });
    ingest.pushSample(
      ["ts", "symbol", "last", "bid", "ask", "volume"],
      [ts.slice(11, 19), q.symbol, q.last, q.bid, q.ask, q.volume],
    );

    // FEATURES: technical
    const techNode = this.nodes.get("technical")!;
    const tech = techNode.run<TechnicalFeatures>(() => {
      const arr = this.prices.get(q.symbol)!;
      const mom = arr.length > 20 ? ((arr[arr.length - 1] - arr[arr.length - 21]) / arr[arr.length - 21]) * 100 : 0;
      return {
        symbol: q.symbol,
        rsi14: +rsi14(arr).toFixed(1),
        momentumPct: +mom.toFixed(3),
        volatilityPct: +stdevPct(arr.slice(-60)).toFixed(4),
        ts,
      };
    });
    this.techFeatures.set(q.symbol, tech);
    techNode.pushSample(
      ["ts", "symbol", "rsi14", "momentum%", "vol%"],
      [ts.slice(11, 19), q.symbol, tech.rsi14, tech.momentumPct, tech.volatilityPct],
    );

    // FEATURES: microstructure
    const microNode = this.nodes.get("microstructure")!;
    const micro = microNode.run<MicrostructureFeatures>(() => {
      const spreadBps = q.last > 0 ? ((q.ask - q.bid) / q.last) * 10_000 : 0;
      const denom = q.bidSize + q.askSize;
      const ofi = denom > 0 ? (q.bidSize - q.askSize) / denom : 0;
      const prevVol = this.lastVolume.get(q.symbol) ?? q.volume;
      this.lastVolume.set(q.symbol, q.volume);
      return {
        symbol: q.symbol,
        spreadBps: +spreadBps.toFixed(2),
        orderFlowImbalance: +ofi.toFixed(3),
        volumeDelta: q.volume - prevVol,
        ts,
      };
    });
    this.microFeatures.set(q.symbol, micro);
    microNode.pushSample(
      ["ts", "symbol", "spreadBps", "ofi", "Δvol"],
      [ts.slice(11, 19), q.symbol, micro.spreadBps, micro.orderFlowImbalance, micro.volumeDelta],
    );

    // MODELS: alpha-technical
    const aTechNode = this.nodes.get("alpha-technical")!;
    const aTech = aTechNode.run<AlphaValue>(() => {
      const rsiSig = (50 - tech.rsi14) / 50; // 과매도 → +
      const momSig = Math.tanh(tech.momentumPct / 2);
      const flowSig = micro.orderFlowImbalance;
      const alpha = Math.tanh(0.6 * rsiSig + 0.3 * momSig + 0.3 * flowSig);
      const conf = Math.max(0.1, 1 - Math.min(1, tech.volatilityPct * 2));
      return { symbol: q.symbol, alpha: +alpha.toFixed(3), confidence: +conf.toFixed(2), source: "technical", ts };
    });
    this.techAlpha.set(q.symbol, aTech);
    aTechNode.pushSample(
      ["ts", "symbol", "alpha", "conf"],
      [ts.slice(11, 19), q.symbol, aTech.alpha, aTech.confidence],
    );

    // MODELS: alpha-ensemble → STRATEGY → EXECUTION
    this.recomputeEnsemble(q.symbol, ts);
    this.recomputePortfolio(ts);

    this.maybeEmitSnapshot();
  }

  // ---- 비정형 레인: 뉴스 ----

  onNews(items: NewsItem[]) {
    if (this.status !== "active") return;
    const ts = new Date().toISOString();

    const streamNode = this.nodes.get("news-stream")!;
    streamNode.run(() => items.length);
    for (const i of items) {
      streamNode.pushSample(
        ["ts", "symbol", "source", "title"],
        [i.fetchedAt.slice(11, 19), i.symbol, i.source, i.title.slice(0, 80)],
      );
    }

    const scoreNode = this.nodes.get("sentiment-score")!;
    const scored: ScoredNewsItem[] = [];
    for (const item of items) {
      const s = scoreNode.run(() => this.tracker.ingest(item));
      scored.push(s);
      scoreNode.pushSample(
        ["ts", "symbol", "score", "conf", "label"],
        [item.fetchedAt.slice(11, 19), item.symbol, s.score, s.confidence, s.label],
      );
      if (Math.abs(s.score) > 0.15) {
        this.log(
          "sentiment-score",
          `${item.symbol} ${s.label} ${s.score >= 0 ? "+" : ""}${s.score} — "${item.title.slice(0, 70)}" [${s.evidence.join(", ")}]`,
        );
      }
    }

    // MODELS: alpha-sentiment (뉴스가 온 심볼만 갱신)
    const aSentNode = this.nodes.get("alpha-sentiment")!;
    for (const item of items) {
      const aSent = aSentNode.run<AlphaValue>(() => {
        const sym = this.tracker.scoreOf(item.symbol)!;
        return {
          symbol: item.symbol,
          alpha: sym.score,
          confidence: +Math.min(1, sym.mentions / 5).toFixed(2),
          source: "sentiment",
          ts,
        };
      });
      this.sentAlpha.set(item.symbol, aSent);
      aSentNode.pushSample(
        ["ts", "symbol", "alpha", "conf", "mentions"],
        [ts.slice(11, 19), item.symbol, aSent.alpha, aSent.confidence, this.tracker.scoreOf(item.symbol)!.mentions],
      );
      this.recomputeEnsemble(item.symbol, ts);
    }
    this.recomputePortfolio(ts);

    this.emit("sentiment", { scored });
    this.maybeEmitSnapshot();
  }

  // ---- 앙상블/포트폴리오/실행 ----

  private recomputeEnsemble(symbol: string, ts: string) {
    const node = this.nodes.get("alpha-ensemble")!;
    const blended = node.run<AlphaValue | null>(() => {
      const t = this.techAlpha.get(symbol);
      const s = this.sentAlpha.get(symbol);
      if (!t && !s) return null;
      const wT = t ? t.confidence : 0;
      const wS = s ? s.confidence : 0;
      const denom = wT + wS;
      if (denom === 0) return null;
      const alpha = ((t?.alpha ?? 0) * wT + (s?.alpha ?? 0) * wS) / denom;
      return {
        symbol,
        alpha: +alpha.toFixed(3),
        confidence: +Math.min(1, denom).toFixed(2),
        source: "ensemble",
        ts,
      };
    });
    if (!blended) return;

    // 알파 안정성: 직전값 대비 변화량
    const prev = this.prevEnsemble.get(symbol);
    if (prev !== undefined) {
      const delta = Math.abs(blended.alpha - prev);
      this.alphaStability = +(this.alphaStability * 0.98 + (1 - Math.min(1, delta * 5)) * 0.02).toFixed(3);
    }
    this.prevEnsemble.set(symbol, blended.alpha);
    this.ensembleAlpha.set(symbol, blended);
    node.pushSample(
      ["ts", "symbol", "alpha", "conf"],
      [ts.slice(11, 19), symbol, blended.alpha, blended.confidence],
    );
  }

  private recomputePortfolio(ts: string) {
    const pfNode = this.nodes.get("portfolio")!;
    const targets = pfNode.run<PortfolioTarget[]>(() => {
      const alphas = [...this.ensembleAlpha.values()];
      const positive = alphas.filter((a) => a.alpha > 0.05);
      const sumPos = positive.reduce((acc, a) => acc + a.alpha, 0);
      const cap = riskManager.limits.maxSymbolWeightPct;
      const equity = state.balance.totalEquityUsd;

      return alphas
        .map((a) => {
          const pos = state.positions.find((p) => p.symbol === a.symbol);
          const curWeight = equity > 0 && pos ? ((pos.curPrice * pos.qty) / equity) * 100 : 0;
          const target =
            a.alpha > 0.05 && sumPos > 0 ? Math.min(cap, (a.alpha / sumPos) * Math.min(100, cap * positive.length)) : 0;
          return {
            symbol: a.symbol,
            alpha: a.alpha,
            targetWeightPct: +target.toFixed(1),
            currentWeightPct: +curWeight.toFixed(1),
            driftPct: +(target - curWeight).toFixed(1),
            ts,
          };
        })
        .sort((a, b) => b.alpha - a.alpha);
    });
    this.portfolioTargets = targets;
    const top = targets[0];
    if (top) {
      pfNode.pushSample(
        ["ts", "symbol", "alpha", "target%", "cur%", "drift%"],
        [ts.slice(11, 19), top.symbol, top.alpha, top.targetWeightPct, top.currentWeightPct, top.driftPct],
      );
    }

    // EXECUTION: 신호 생성 (임계치 3%p, 심볼당 5분 쿨다운)
    const exNode = this.nodes.get("execution-router")!;
    exNode.run(() => {
      const now = Date.now();
      for (const t of targets) {
        if (Math.abs(t.driftPct) < 3) continue;
        const last = this.signalCooldown.get(t.symbol) ?? 0;
        if (now - last < 5 * 60_000) continue;
        this.signalCooldown.set(t.symbol, now);

        const side = t.driftPct > 0 ? "buy" : "sell";
        const pos = state.positions.find((p) => p.symbol === t.symbol);
        const amountUsd = (Math.abs(t.driftPct) / 100) * state.balance.totalEquityUsd;
        const blocked = riskManager.check({
          amountUsd,
          side,
          resultingOpenPositions: state.positions.length + (side === "buy" && !pos ? 1 : 0),
          resultingSymbolWeightPct: t.targetWeightPct,
        });
        const signal: ExecutionSignal = {
          symbol: t.symbol,
          side,
          reason: `앙상블 알파 ${t.alpha >= 0 ? "+" : ""}${t.alpha}, 비중 괴리 ${t.driftPct}%p`,
          strengthPct: Math.abs(t.driftPct),
          blocked,
          ts,
        };
        this.signals.unshift(signal);
        if (this.signals.length > 100) this.signals.length = 100;
        exNode.pushSample(
          ["ts", "symbol", "side", "strength%", "risk"],
          [ts.slice(11, 19), t.symbol, side, signal.strengthPct, blocked ?? "PASS"],
        );
        this.log(
          "execution-router",
          blocked
            ? `${t.symbol} ${side.toUpperCase()} 신호 차단 — ${blocked}`
            : `${t.symbol} ${side.toUpperCase()} 신호 (${signal.strengthPct.toFixed(1)}%p) — ${signal.reason}`,
        );
      }
    });
  }

  private signalCooldown = new Map<string, number>();

  // ---- 로그/스냅샷 ----

  log(node: string, message: string) {
    const line: PipelineLogLine = { ts: new Date().toISOString(), node, message };
    this.logs.unshift(line);
    if (this.logs.length > LOG_MAX) this.logs.length = LOG_MAX;
    this.emit("log", line);
  }

  private maybeEmitSnapshot() {
    const now = Date.now();
    if (now - this.lastSnapshotEmit < 1000) return;
    this.lastSnapshotEmit = now;
    this.emit("snapshot", this.snapshot());
  }

  snapshot(): PipelineSnapshot {
    const nodes: PipelineNodeSummary[] = [...this.nodes.values()].map((n) => ({
      ...n.def,
      metrics: n.metrics(),
    }));
    const active = nodes.filter((n) => n.metrics.status === "active").length;
    const latency = nodes.reduce((acc, n) => acc + n.metrics.avgLatencyMs, 0);
    return {
      status: this.status,
      latencyMs: +latency.toFixed(2),
      nodesActive: active,
      nodesTotal: nodes.length,
      alphaStability: this.alphaStability,
      stages: STAGES,
      nodes,
      edges: EDGES,
    };
  }

  nodeDetail(id: string): PipelineNodeDetail | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    return {
      ...n.def,
      metrics: n.metrics(),
      sample: { columns: n.sampleColumns, rows: n.sampleRows },
    };
  }
}

export const pipeline = new PipelineEngine();
