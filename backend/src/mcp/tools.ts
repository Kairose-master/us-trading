import { state } from "../api/state.js";
import { pipeline } from "../pipeline/engine.js";
import { autoTrader } from "../trade/auto-trader.js";
import { executeOrder } from "../trade/execute.js";
import { config } from "../config.js";
import { currentMarketSession } from "../core/marketSession.js";
import { cryptoDesk, CRYPTO_MARKETS } from "../crypto/desk.js";
import { upbit } from "../crypto/upbit.js";
import { runBacktest, SIGNALS } from "../crypto/backtest.js";

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

export function mcpTools(): McpToolDef[] {
  const readOnly = [
    priceLookup,
    pipelineReport,
    sentimentReport,
    accountBalance,
    upbitPriceLookup,
    upbitPipelineReport,
    upbitBacktestReport,
  ];
  return config.MCP_TRADING ? [...readOnly, placeOrder, autoTradeTool] : readOnly;
}
