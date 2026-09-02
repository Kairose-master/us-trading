import { state } from "../api/state.js";
import { pipeline } from "../pipeline/engine.js";
import { autoTrader } from "../trade/auto-trader.js";
import { executeOrder } from "../trade/execute.js";
import { config } from "../config.js";
import { currentMarketSession } from "../core/marketSession.js";
import { cryptoDesk, CRYPTO_MARKETS } from "../crypto/desk.js";
import { upbit } from "../crypto/upbit.js";
import { runBacktest, SIGNALS } from "../crypto/backtest.js";
import { walkForwardValidate } from "../ml/validate.js";
import { DEFAULT_PARAMS } from "../ml/train.js";
import { FEATURE_NAMES } from "../ml/features.js";
import { tuneHyperparams } from "../ml/tune.js";

/**
 * MCP 워커 툴 — Handsel office가 이 백엔드를 워커로 탈부착하는 표면.
 *
 * Handsel의 mcp-client(callMcpTool)는 툴을 "단일 string 인자"로 호출한다
 * (docs/office-connectors.md의 제약 2). 그래서 모든 툴이 query: string 하나만
 * 받고, 사람이 읽고 채점할 수 있는 텍스트 딜리버러블을 돌려준다.
 *
 * 주문/자동매매 툴은 MCP_TRADING=true일 때만 노출된다 — 기본은 읽기 전용
 * 워커라서, 신뢰하지 않는 office에 붙여도 시장 데이터 이상은 내주지 않는다.
 */

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  handler: (query: string) => Promise<string> | string;
}

const QUERY_SCHEMA = (desc: string): McpToolDef["inputSchema"] => ({
  type: "object",
  properties: { query: { type: "string", description: desc } },
  required: ["query"],
});

/** 쿼리에서 실재하는(시세가 흐르는) 티커만 뽑는다 — 없는 심볼을 지어내지 않는다 */
export function extractKnownSymbols(query: string): string[] {
  const candidates = [...new Set(query.toUpperCase().match(/\b[A-Z]{1,5}\b/g) ?? [])];
  return candidates.filter((c) => state.quotes.has(c));
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function envLine(): string {
  return `[env] mode=${config.KIS_MODE} mock=${config.MOCK_DATA} session=${currentMarketSession()} ts=${new Date().toISOString()}`;
}

// ===== 읽기 전용 툴 =====

const priceLookup: McpToolDef = {
  name: "us_price_lookup",
  description:
    "Look up real-time quotes for US stock tickers mentioned in the query (NASDAQ/NYSE/AMEX). Returns last price, change, bid/ask, volume per symbol. Symbols without a live feed are listed as unavailable rather than invented.",
  inputSchema: QUERY_SCHEMA("Free text containing one or more US tickers, e.g. 'NVDA and TSLA current price'"),
  handler: (query) => {
    const symbols = extractKnownSymbols(query);
    if (symbols.length === 0) {
      const known = [...state.quotes.keys()].join(", ");
      return `쿼리에서 시세가 흐르는 티커를 찾지 못했습니다.\n현재 구독 중인 심볼: ${known}\n${envLine()}`;
    }
    const lines = symbols.map((s) => {
      const q = state.quotes.get(s)!;
      return `${s} (${q.exch}) last=${fmtUsd(q.last)} chg=${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePct.toFixed(2)}%) bid=${fmtUsd(q.bid)} ask=${fmtUsd(q.ask)} vol=${q.volume.toLocaleString()}${q.halted ? " [HALTED]" : ""}`;
    });
    return [...lines, envLine()].join("\n");
  },
};

const pipelineReport: McpToolDef = {
  name: "us_pipeline_report",
  description:
    "Report the live data/ML pipeline state: per-node measured latency and throughput, ensemble alpha per symbol, portfolio targets vs current weights, and recent execution signals. All numbers are measured, none fabricated.",
  inputSchema: QUERY_SCHEMA("What to focus on (symbols or 'all'); the full report is returned regardless"),
  handler: () => {
    const snap = pipeline.snapshot();
    const nodeLines = snap.nodes.map(
      (n) =>
        `  ${n.id} [${n.metrics.status}] avg=${n.metrics.avgLatencyMs.toFixed(2)}ms thr=${n.metrics.throughputPerSec.toFixed(1)}/s total=${n.metrics.totalMsgs}`,
    );
    const targets = pipeline.portfolioTargets
      .slice(0, 10)
      .map(
        (t) =>
          `  ${t.symbol} alpha=${t.alpha >= 0 ? "+" : ""}${t.alpha} target=${t.targetWeightPct}% current=${t.currentWeightPct}% drift=${t.driftPct}%p`,
      );
    const signals = pipeline.signals
      .slice(0, 5)
      .map((s) => `  ${s.ts.slice(11, 19)} ${s.symbol} ${s.side.toUpperCase()} ${s.strengthPct.toFixed(1)}%p ${s.blocked ? `BLOCKED(${s.blocked})` : "PASS"}`);
    return [
      `PIPELINE ${snap.status} — nodes ${snap.nodesActive}/${snap.nodesTotal}, latency ${snap.latencyMs.toFixed(2)}ms, alphaStability ${snap.alphaStability}`,
      `NODES:`,
      ...nodeLines,
      `PORTFOLIO TARGETS (ensemble alpha):`,
      ...(targets.length ? targets : ["  (none yet)"]),
      `RECENT EXECUTION SIGNALS:`,
      ...(signals.length ? signals : ["  (none yet)"]),
      envLine(),
    ].join("\n");
  },
};

const sentimentReport: McpToolDef = {
  name: "us_sentiment_report",
  description:
    "Report market sentiment computed from ingested news headlines (lexicon-scored, evidence words preserved). Per-symbol EMA scores, mention counts, top drivers, and the most recent scored headlines.",
  inputSchema: QUERY_SCHEMA("Symbols to focus on, or free text; the full overview is always included"),
  handler: (query) => {
    const t = pipeline.tracker;
    const index = t.marketIndex();
    const focus = new Set(extractKnownSymbols(query));
    const symbols = t.bySymbol().filter((s) => s.mentions > 0);
    const symLines = symbols.map(
      (s) =>
        `  ${s.symbol} ${s.label} ${s.score >= 0 ? "+" : ""}${s.score} mentions=${s.mentions}${s.topDriver ? ` driver="${s.topDriver}"` : ""}`,
    );
    const feed = t.feed
      .filter((f) => focus.size === 0 || focus.has(f.symbol))
      .slice(0, 8)
      .map((f) => `  ${f.fetchedAt.slice(11, 19)} ${f.symbol} ${f.label} ${f.score >= 0 ? "+" : ""}${f.score} [${f.evidence.join(",")}] "${f.title.slice(0, 90)}" (${f.source})`);
    return [
      `SENTIMENT INDEX ${index >= 0 ? "+" : ""}${index} — total mentions ${t.totalMentions()}`,
      `PER-SYMBOL:`,
      ...(symLines.length ? symLines : ["  (no scored headlines yet)"]),
      `RECENT SCORED HEADLINES:`,
      ...(feed.length ? feed : ["  (none)"]),
      envLine(),
    ].join("\n");
  },
};

const accountBalance: McpToolDef = {
  name: "us_account_balance",
  description:
    "Return the trading account's balance, equity, PnL and current positions with weights. Query text is accepted but unused.",
  inputSchema: QUERY_SCHEMA("Accepted but unused"),
  handler: () => {
    const b = state.balance;
    const posLines = state.positions.map(
      (p) =>
        `  ${p.symbol} ${p.qty}주 avg=${fmtUsd(p.avgPrice)} cur=${fmtUsd(p.curPrice)} pnl=${fmtUsd(p.pnlUsd)} (${p.pnlPct.toFixed(2)}%) weight=${p.weightPct}%`,
    );
    return [
      `BALANCE cash=${fmtUsd(b.cashUsd)} equity=${fmtUsd(b.totalEquityUsd)} todayPnl=${fmtUsd(b.todayPnlUsd)} (${b.todayPnlPct}%)`,
      `POSITIONS (${state.positions.length}):`,
      ...(posLines.length ? posLines : ["  (none)"]),
      envLine(),
    ].join("\n");
  },
};

// ===== 거래 툴 (MCP_TRADING=true에서만 노출) =====

/** "buy 2 AAPL", "sell 1 NVDA @ 180.5", "AAPL 2주 매수" 형태를 파싱한다. Pure. */
export function parseOrderQuery(
  query: string,
): { side: "buy" | "sell"; qty: number; symbol: string; price?: number } | { error: string } {
  const text = query.trim();
  const side: "buy" | "sell" | null = /\b(buy)\b|매수/i.test(text)
    ? "buy"
    : /\b(sell)\b|매도/i.test(text)
      ? "sell"
      : null;
  if (!side) return { error: "주문 방향을 찾지 못했습니다 — 'buy'/'sell' 또는 '매수'/'매도'를 포함하세요" };
  const symbols = extractKnownSymbols(text.replace(/\b(BUY|SELL)\b/gi, ""));
  if (symbols.length !== 1) {
    return { error: `주문 심볼을 정확히 하나 지정하세요 (인식된 심볼: ${symbols.join(", ") || "없음"})` };
  }
  const qtyMatch = text.match(/(\d+)\s*(?:주|shares?)?/);
  const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : NaN;
  if (!Number.isInteger(qty) || qty <= 0) return { error: "수량을 찾지 못했습니다 — 예: 'buy 2 AAPL'" };
  const priceMatch = text.match(/@\s*\$?(\d+(?:\.\d+)?)/);
  return {
    side,
    qty,
    symbol: symbols[0],
    ...(priceMatch ? { price: parseFloat(priceMatch[1]) } : {}),
  };
}

const placeOrder: McpToolDef = {
  name: "us_place_order",
  description:
    "Place one US stock order through the same risk-gated execution path as manual orders. Format: 'buy 2 AAPL' or 'sell 1 NVDA @ 180.5' (limit when @price given, else market). Refused when the risk manager blocks it.",
  inputSchema: QUERY_SCHEMA("Order in free text, e.g. 'buy 2 AAPL' or 'sell 1 NVDA @ 180.5'"),
  handler: async (query) => {
    const parsed = parseOrderQuery(query);
    if ("error" in parsed) return `주문 파싱 실패: ${parsed.error}\n${envLine()}`;
    const result = await executeOrder({
      symbol: parsed.symbol,
      side: parsed.side,
      orderType: parsed.price !== undefined ? "limit" : "market",
      qty: parsed.qty,
      price: parsed.price,
      session: "regular",
      source: "mcp",
      reason: `MCP worker order: "${query.slice(0, 120)}"`,
    });
    if (!result.ok) return `주문 거부(${result.blockedBy}): ${result.error}\n${envLine()}`;
    return `주문 접수 ${result.orderId} — ${parsed.side.toUpperCase()} ${parsed.symbol} x${parsed.qty} @ ${parsed.price !== undefined ? fmtUsd(parsed.price) : `market(${fmtUsd(result.refPrice)})`}\n${envLine()}`;
  },
};

const autoTradeTool: McpToolDef = {
  name: "us_auto_trade",
  description:
    "Control the auto-trading executor that turns pipeline signals into risk-gated orders. Query: 'on' | 'off' | 'status' (또는 '켜'/'꺼'/'상태'). Refuses to enable on the real-money path without AUTO_TRADE_ALLOW_REAL.",
  inputSchema: QUERY_SCHEMA("'on' | 'off' | 'status'"),
  handler: (query) => {
    const q = query.trim().toLowerCase();
    if (/\b(on|start|enable)\b|켜/.test(q)) {
      const err = autoTrader.enable();
      return err ? `자동매매 켜기 실패: ${err}\n${envLine()}` : `자동매매 ON\n${envLine()}`;
    }
    if (/\b(off|stop|disable)\b|꺼/.test(q)) {
      autoTrader.disable();
      return `자동매매 OFF\n${envLine()}`;
    }
    const s = autoTrader.status();
    const recent = s.recent
      .slice(0, 5)
      .map((r) => `  ${r.ts.slice(11, 19)} ${r.symbol} ${r.side.toUpperCase()} x${r.qty} → ${r.outcome}${r.orderId ? ` (${r.orderId})` : ""} — ${r.detail.slice(0, 80)}`);
    return [
      `AUTO-TRADE ${s.enabled ? "ON" : "OFF"} killSwitch=${s.killSwitchActive} executed=${s.executedToday}`,
      ...(recent.length ? ["RECENT:", ...recent] : []),
      envLine(),
    ].join("\n");
  },
};

// ===== 크립토 (Upbit) 읽기 전용 툴 =====

const upbitPriceLookup: McpToolDef = {
  name: "upbit_price_lookup",
  description:
    "Live Upbit KRW-market quotes for the coins in the query (BTC/ETH/XRP/SOL/DOGE): price, 24h change, high/low, volume. Real public Upbit data at call time.",
  inputSchema: QUERY_SCHEMA("Free text naming coins, e.g. 'BTC ETH price'"),
  handler: (query) => {
    const wanted = new Set((query.toUpperCase().match(/\b[A-Z]{2,5}\b/g) ?? []).map((s) => `KRW-${s}`));
    const quotes = cryptoDesk.quotes().filter((q) => wanted.size === 0 || wanted.has(q.market));
    if (quotes.length === 0) {
      return `해당 마켓의 시세가 아직 없습니다. 추적 중: ${CRYPTO_MARKETS.join(", ")}\n${envLine()}`;
    }
    const lines = quotes.map(
      (q) =>
        `${q.market}: ₩${q.priceKrw.toLocaleString()} (${q.changePct >= 0 ? "+" : ""}${q.changePct}%) high=₩${q.high.toLocaleString()} low=₩${q.low.toLocaleString()} vol24h=${q.volume24h.toFixed(2)}`,
    );
    return [...lines, envLine()].join("\n");
  },
};

const upbitPipelineReport: McpToolDef = {
  name: "upbit_market_report",
  description:
    "Crypto desk report: live Upbit pipeline metrics, per-coin ensemble alpha, portfolio targets, news sentiment with evidence words, and recent signals. All measured from live Upbit + Google News data.",
  inputSchema: QUERY_SCHEMA("Focus coins or 'all'"),
  handler: () => {
    const snap = cryptoDesk.pipeline.snapshot();
    const t = cryptoDesk.pipeline.tracker;
    const targets = cryptoDesk.pipeline.portfolioTargets
      .slice(0, 6)
      .map((x) => `  ${x.symbol} alpha=${x.alpha >= 0 ? "+" : ""}${x.alpha} target=${x.targetWeightPct}% drift=${x.driftPct}%p`);
    const sent = t
      .bySymbol()
      .filter((s) => s.mentions > 0)
      .map((s) => `  ${s.symbol} ${s.label} ${s.score >= 0 ? "+" : ""}${s.score} (${s.mentions} mentions)${s.topDriver ? ` — "${s.topDriver.slice(0, 70)}"` : ""}`);
    const quotes = cryptoDesk.quotes().map((q) => `  ${q.market} ₩${q.priceKrw.toLocaleString()} (${q.changePct >= 0 ? "+" : ""}${q.changePct}%)`);
    return [
      `UPBIT CRYPTO DESK — pipeline ${snap.status}, nodes ${snap.nodesActive}/${snap.nodesTotal}, latency ${snap.latencyMs.toFixed(2)}ms, alphaStability ${snap.alphaStability}`,
      `QUOTES:`,
      ...quotes,
      `ALPHA TARGETS:`,
      ...(targets.length ? targets : ["  (none yet)"]),
      `NEWS SENTIMENT:`,
      ...(sent.length ? sent : ["  (no scored headlines yet)"]),
      envLine(),
    ].join("\n");
  },
};

const upbitBacktestReport: McpToolDef = {
  name: "upbit_backtest_report",
  description:
    "Run a REAL backtest on live Upbit daily candles and report Sharpe, annualized return vs buy&hold, max drawdown, win rate, trades. Query names a market (default KRW-BTC) and optionally a signal id: vol-spike-reversion | rsi-reversion | momentum-20 | vol-regime (default: all four, 365 days).",
  inputSchema: QUERY_SCHEMA("e.g. 'KRW-ETH momentum-20' or 'BTC all signals'"),
  handler: async (query) => {
    const up = query.toUpperCase();
    const coin = (up.match(/\b(BTC|ETH|XRP|SOL|DOGE)\b/) ?? ["BTC"])[0];
    const market = `KRW-${coin}`;
    const named = SIGNALS.filter((s) => query.toLowerCase().includes(s.id));
    const signals = named.length > 0 ? named : SIGNALS;
    const candles = (await upbit.dayCandles(market, 365)).map((c) => ({
      t: c.candle_date_time_utc.slice(0, 10),
      o: c.opening_price,
      h: c.high_price,
      l: c.low_price,
      c: c.trade_price,
      v: c.candle_acc_trade_volume,
    }));
    const rows = signals.map((s) => {
      const bt = runBacktest(candles, s, market);
      const m = bt.metrics;
      return `  ${s.name} [${s.id}]: annual=${m.annualReturnPct}% (B&H ${m.benchmarkReturnPct}%) sharpe=${m.sharpe} MDD=${m.maxDrawdownPct}% winRate=${m.winRatePct}% trades=${m.trades} exposure=${m.exposurePct}%`;
    });
    return [
      `# Upbit backtest — ${market}, ${candles.length} daily candles (${candles[0]?.t} ~ ${candles[candles.length - 1]?.t})`,
      `convention: signal at close t → position for t+1 return; long/cash only (no lookahead, no shorting)`,
      ...rows,
      envLine(),
    ].join("\n");
  },
};

const mlAlphaReport: McpToolDef = {
  name: "ml_alpha_report",
  description:
    "Train a REAL logistic-regression alpha model on live Upbit daily candles (walk-forward: 70% train, 30% out-of-sample) and report learned feature weights, training loss curve endpoints, and in-sample vs OUT-OF-SAMPLE backtest metrics. Only the OOS numbers are trustworthy and the report says so. Query names a coin (default BTC).",
  inputSchema: QUERY_SCHEMA("e.g. 'ETH' or 'BTC threshold 0.6'"),
  handler: async (query) => {
    const coin = (query.toUpperCase().match(/\b(BTC|ETH|XRP|SOL|DOGE)\b/) ?? ["BTC"])[0];
    const market = `KRW-${coin}`;
    const qMatch = query.match(/0\.\d+/);
    const quantile = qMatch ? Math.min(0.9, Math.max(0.5, parseFloat(qMatch[0]))) : 0.6;
    const candles = (await upbit.dayCandles(market, 500)).map((c) => ({
      t: c.candle_date_time_utc.slice(0, 10),
      o: c.opening_price,
      h: c.high_price,
      l: c.low_price,
      c: c.trade_price,
      v: c.candle_acc_trade_volume,
    }));
    const r = walkForwardValidate(candles, market, DEFAULT_PARAMS, quantile);
    const w = r.model.weights.map((v, i) => `${FEATURE_NAMES[i]}=${v}`).join(" ");
    const first = r.model.epochs[0];
    const last = r.model.epochs[r.model.epochs.length - 1];
    return [
      `# ML alpha report — ${market} (logistic regression, walk-forward)`,
      `train: ${r.trainRange.from}~${r.trainRange.to} (${r.trainRange.samples} samples, ${r.model.steps} SGD steps) · test(OOS): ${r.testRange.from}~${r.testRange.to}`,
      `loss: epoch1=${first?.loss} → epoch${last?.epoch}=${last?.loss} · train accuracy ${(r.model.finalAccuracy * 100).toFixed(1)}% · threshold ${r.threshold} (train-prob q${r.quantile})`,
      `weights: ${w}`,
      `IN-SAMPLE  : annual=${r.inSample.annualReturnPct}% sharpe=${r.inSample.sharpe} MDD=${r.inSample.maxDrawdownPct}% (참고용 — 과적합 포함)`,
      `OUT-SAMPLE : annual=${r.outOfSample.annualReturnPct}% (B&H ${r.outOfSample.benchmarkReturnPct}%) sharpe=${r.outOfSample.sharpe} MDD=${r.outOfSample.maxDrawdownPct}% winRate=${r.outOfSample.winRatePct}% trades=${r.outOfSample.trades}`,
      `신뢰할 수 있는 숫자는 OUT-SAMPLE 뿐이다. convention: t종가 시그널 → t+1 적용, 롱/현금만, 수수료 미반영.`,
      envLine(),
    ].join("\n");
  },
};

const mlTuneReport: McpToolDef = {
  name: "ml_tune_report",
  description:
    "Auto-search training hyperparameters (random search + coordinate-descent refinement, ~100 real trials) on live Upbit candles with a 3-way split: 60% train / 20% validation (the tuner's objective) / 20% UNTOUCHED holdout. Reports best params, validation objective, and holdout metrics — only the holdout number is trustworthy, and validation-vs-holdout gap exposes tuner overfitting honestly.",
  inputSchema: QUERY_SCHEMA("Coin, e.g. 'BTC' or 'ETH'"),
  handler: async (query) => {
    const coin = (query.toUpperCase().match(/\b(BTC|ETH|XRP|SOL|DOGE)\b/) ?? ["BTC"])[0];
    const market = `KRW-${coin}`;
    const candles = (await upbit.dayCandles(market, 500)).map((c) => ({
      t: c.candle_date_time_utc.slice(0, 10),
      o: c.opening_price,
      h: c.high_price,
      l: c.low_price,
      c: c.trade_price,
      v: c.candle_acc_trade_volume,
    }));
    const r = tuneHyperparams(candles, market);
    const b = r.best;
    const h = r.holdout;
    return [
      `# Hyperparameter tune report — ${market} (${r.trials.length} real trials)`,
      `splits: train~${r.splits.trainEnd} / val~${r.splits.valEnd} (tuner objective) / holdout~${r.splits.holdoutEnd} (untouched)`,
      `best: lr=${b.learningRate.toFixed(4)} epochs=${b.epochs} l2=${b.l2.toExponential(2)} batch=${b.batchSize} quantile=${b.quantile.toFixed(3)} → threshold ${r.finalThreshold}`,
      `validation objective (Sharpe): ${r.bestObjective} — 튜너가 본 숫자, 과적합 포함`,
      `HOLDOUT: annual=${h.annualReturnPct}% (B&H ${h.benchmarkReturnPct}%) sharpe=${h.sharpe} MDD=${h.maxDrawdownPct}% winRate=${h.winRatePct}% trades=${h.trades} exposure=${h.exposurePct}%`,
      `val ${r.bestObjective} vs holdout ${h.sharpe}의 간극이 곧 튜너 과적합의 크기다. 신뢰할 숫자는 HOLDOUT뿐.`,
      envLine(),
    ].join("\n");
  },
};

export function mcpTools(): McpToolDef[] {
  const readOnly = [
    priceLookup,
    pipelineReport,
    sentimentReport,
    accountBalance,
    upbitPriceLookup,
    upbitPipelineReport,
    upbitBacktestReport,
    mlAlphaReport,
    mlTuneReport,
  ];
  return config.MCP_TRADING ? [...readOnly, placeOrder, autoTradeTool] : readOnly;
}
