/**
 * us-trading 읽기 전용 MCP 워커 (Vercel 서버리스).
 *
 * Handsel office가 워커로 탈부착하는 공개 접점. 로컬 백엔드(backend/)의 /mcp와
 * 같은 프로토콜 슬라이스(initialize → tools/list → tools/call, 단일 string 인자)를
 * 구현하되, 서버리스라는 사실에 정직하게 맞춘다:
 *
 *  - 상시 파이프라인이 없으므로, 매 호출마다 실데이터를 그 자리에서 계산한다
 *    (Yahoo Finance v8 chart — 키 불필요 — 에서 시세/일봉, Google News RSS에서
 *    헤드라인 → 렉시콘 채점). 어떤 수치도 지어내지 않는다.
 *  - 계좌·주문·자동매매 툴은 없다. 그것들은 KIS 키가 있는 로컬 백엔드에만 있고,
 *    이 워커는 분석 리포트까지만 쓴다 (securities-desk의 "draft only" 철학).
 *
 * 인증: MCP_AUTH_TOKEN env가 설정돼 있으면 Bearer 필수, 없으면 공개 읽기 전용.
 * 의존성 zero — Vercel 기본 Node 런타임으로 그대로 뜬다.
 */

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_SYMBOLS = ["NVDA", "AAPL", "TSLA", "MSFT"];
const MAX_SYMBOLS = 4;
const FETCH_TIMEOUT_MS = 6000;

// ===== 렉시콘 채점 (backend/src/sentiment/scorer.ts와 동일 로직) =====

const POSITIVE: Record<string, number> = {
  beat: 2, beats: 2, surge: 2, surges: 2, soar: 2, soars: 2, rally: 2, record: 1,
  upgrade: 2, upgraded: 2, outperform: 2, bullish: 2, buy: 1, growth: 1, strong: 1,
  gain: 1, gains: 1, jump: 2, jumps: 2, rise: 1, rises: 1, up: 1, profit: 1,
  raise: 1, raises: 1, wins: 1, approval: 1, partnership: 1, expands: 1, momentum: 1,
  demand: 1, tops: 2, exceeds: 2, boom: 2,
};
const NEGATIVE: Record<string, number> = {
  miss: 2, misses: 2, plunge: 2, plunges: 2, crash: 2, downgrade: 2, downgraded: 2,
  bearish: 2, sell: 1, selloff: 2, weak: 1, fall: 1, falls: 1, drop: 1, drops: 1,
  down: 1, loss: 1, losses: 1, cut: 1, cuts: 1, layoffs: 2, lawsuit: 2, probe: 2,
  investigation: 2, recall: 2, fined: 2, warning: 1, warns: 1, delay: 1, delays: 1,
  concern: 1, concerns: 1, risk: 1, risks: 1, slump: 2, halted: 1, fraud: 2,
  tumbles: 2, sinks: 2, slides: 1,
};
const NEGATORS = new Set(["not", "no", "never", "without", "fails", "fail"]);

function scoreHeadline(text: string): { score: number; confidence: number; hits: string[] } {
  const tokens = text.toLowerCase().replace(/[^a-z0-9'\s%-]/g, " ").split(/\s+/).filter(Boolean);
  let raw = 0;
  let weightAbs = 0;
  const hits: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let w = 0;
    if (t in POSITIVE) w = POSITIVE[t];
    else if (t in NEGATIVE) w = -NEGATIVE[t];
    if (w === 0) continue;
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (NEGATORS.has(tokens[j])) {
        w = -w;
        break;
      }
    }
    raw += w;
    weightAbs += Math.abs(w);
    hits.push(t);
  }
  if (weightAbs === 0) return { score: 0, confidence: 0, hits: [] };
  return { score: +Math.tanh(raw / 3).toFixed(3), confidence: +Math.min(1, weightAbs / 4).toFixed(2), hits };
}

function labelOf(score: number): string {
  return score > 0.15 ? "BULLISH" : score < -0.15 ? "BEARISH" : "NEUTRAL";
}

// ===== 지표 계산 (backend/src/pipeline/engine.ts와 동일 로직) =====

function rsi14(prices: number[]): number {
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

// ===== 실데이터 수집 =====

const TICKER_STOPWORDS = new Set([
  "A", "I", "AI", "US", "USA", "ETF", "THE", "AND", "FOR", "NOT", "ALL", "NEW", "TOP",
  "CEO", "IPO", "GDP", "FED", "SEC", "NYSE", "USD", "BUY", "SELL", "NOW", "VS", "ON",
  "IN", "AT", "TO", "OF", "IS", "ARE", "MY", "OUR", "WHAT", "PLEASE", "STOCK", "PRICE",
]);

function extractCandidates(query: string): string[] {
  const raw = [...new Set(query.toUpperCase().match(/\b[A-Z]{1,5}\b/g) ?? [])];
  return raw.filter((c) => !TICKER_STOPWORDS.has(c)).slice(0, MAX_SYMBOLS);
}

interface MarketData {
  symbol: string;
  price: number;
  prevClose: number;
  changePct: number;
  closes: number[]; // 일봉 종가 (약 3개월)
}

async function fetchMarket(symbol: string): Promise<MarketData | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number }; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const r = data.chart?.result?.[0];
    const price = r?.meta?.regularMarketPrice;
    if (!r || typeof price !== "number") return null;
    const closes = (r.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => typeof c === "number");
    const prevClose = closes.length > 1 ? closes[closes.length - 2] : (r.meta?.chartPreviousClose ?? price);
    return {
      symbol,
      price,
      prevClose,
      changePct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      closes,
    };
  } catch {
    return null;
  }
}

interface ScoredHeadline {
  title: string;
  source: string;
  score: number;
  confidence: number;
  hits: string[];
}

async function fetchNews(symbol: string): Promise<ScoredHeadline[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${symbol} stock`)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return [];
    const xml = await res.text();
    const out: ScoredHeadline[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null && out.length < 8) {
      const block = m[1];
      const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "";
      const s = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1] ?? "GoogleNews";
      const title = t
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/ - [^-]+$/, "")
        .trim();
      if (!title) continue;
      const { score, confidence, hits } = scoreHeadline(title);
      out.push({ title, source: s, score, confidence, hits });
    }
    return out;
  } catch {
    return [];
  }
}

// ===== 분석 (심볼당 하나의 완결된 뷰) =====

interface Analysis {
  m: MarketData;
  rsi: number;
  momentumPct: number;
  volPct: number;
  techAlpha: number;
  techConf: number;
  news: ScoredHeadline[];
  sentScore: number; // 신뢰도 가중 평균
  sentConf: number;
  ensemble: number;
}

async function analyze(symbol: string): Promise<Analysis | null> {
  const [m, news] = await Promise.all([fetchMarket(symbol), fetchNews(symbol)]);
  if (!m) return null;
  const rsi = +rsi14(m.closes).toFixed(1);
  const momentumPct =
    m.closes.length > 20 ? +(((m.closes[m.closes.length - 1] - m.closes[m.closes.length - 21]) / m.closes[m.closes.length - 21]) * 100).toFixed(2) : 0;
  const volPct = +stdevPct(m.closes.slice(-60)).toFixed(3);
  const rsiSig = (50 - rsi) / 50;
  const momSig = Math.tanh(momentumPct / 10);
  const techAlpha = +Math.tanh(0.6 * rsiSig + 0.4 * momSig).toFixed(3);
  const techConf = +Math.max(0.1, 1 - Math.min(1, volPct / 5)).toFixed(2);

  let num = 0;
  let den = 0;
  for (const h of news) {
    num += h.score * h.confidence;
    den += h.confidence;
  }
  const sentScore = den > 0 ? +(num / den).toFixed(3) : 0;
  const sentConf = +Math.min(1, den / 3).toFixed(2);
  const wSum = techConf + sentConf;
  const ensemble = wSum > 0 ? +((techAlpha * techConf + sentScore * sentConf) / wSum).toFixed(3) : 0;
  return { m, rsi, momentumPct, volPct, techAlpha, techConf, news, sentScore, sentConf, ensemble };
}

async function analyzeQuery(query: string): Promise<{ analyses: Analysis[]; skipped: string[] }> {
  const candidates = extractCandidates(query);
  const symbols = candidates.length > 0 ? candidates : DEFAULT_SYMBOLS;
  const results = await Promise.all(symbols.map(analyze));
  const analyses: Analysis[] = [];
  const skipped: string[] = [];
  results.forEach((r, i) => {
    if (r) analyses.push(r);
    else skipped.push(symbols[i]);
  });
  return { analyses, skipped };
}

function metaLine(skipped: string[]): string {
  const skip = skipped.length ? ` | no data (skipped, not invented): ${skipped.join(", ")}` : "";
  return `[data] quotes+daily: Yahoo Finance v8 chart · headlines: Google News RSS · scored by deterministic lexicon · ts=${new Date().toISOString()}${skip}`;
}

const fmt = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;

// ===== 툴 =====

interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: (query: string) => Promise<string>;
}

const QUERY_SCHEMA = (desc: string) => ({
  type: "object",
  properties: { query: { type: "string", description: desc } },
  required: ["query"],
});

const TOOLS: ToolDef[] = [
  {
    name: "us_market_report",
    description:
      "Full analyst report for the US tickers in the query (default NVDA/AAPL/TSLA/MSFT): live price, RSI(14), 20-day momentum, volatility, news sentiment with evidence words, and a blended alpha per symbol. Every number is computed from live Yahoo Finance and Google News data at call time; symbols without data are skipped, never invented.",
    inputSchema: QUERY_SCHEMA("Free text naming US tickers, e.g. 'NVDA TSLA outlook'"),
    handler: async (query) => {
      const { analyses, skipped } = await analyzeQuery(query);
      if (analyses.length === 0) return `데이터를 가져올 수 있는 심볼이 없습니다.\n${metaLine(skipped)}`;
      const sections = analyses.map((a) => {
        const newsLines = a.news
          .slice(0, 3)
          .map((h) => `    · [${labelOf(h.score)} ${signed(h.score)}] "${h.title.slice(0, 90)}" (${h.source})${h.hits.length ? ` evidence: ${h.hits.join(",")}` : ""}`);
        return [
          `## ${a.m.symbol} — ${fmt(a.m.price)} (${signed(+a.m.changePct.toFixed(2))}% vs prev close)`,
          `  technicals: RSI14=${a.rsi} momentum20d=${signed(a.momentumPct)}% vol(daily)=${a.volPct}% → techAlpha=${signed(a.techAlpha)} (conf ${a.techConf})`,
          `  sentiment: ${labelOf(a.sentScore)} ${signed(a.sentScore)} from ${a.news.length} scored headlines (conf ${a.sentConf})`,
          ...newsLines,
          `  blended alpha: ${signed(a.ensemble)} — ${a.ensemble > 0.1 ? "constructive" : a.ensemble < -0.1 ? "cautious" : "neutral"}`,
        ].join("\n");
      });
      return [`# US market report`, ...sections, metaLine(skipped)].join("\n\n");
    },
  },
  {
    name: "us_price_lookup",
    description:
      "Live quotes for the US tickers in the query: last price, previous close, day change %, and 20-day momentum. Data from Yahoo Finance at call time.",
    inputSchema: QUERY_SCHEMA("Free text naming US tickers, e.g. 'NVDA and AAPL price'"),
    handler: async (query) => {
      const { analyses, skipped } = await analyzeQuery(query);
      if (analyses.length === 0) return `데이터를 가져올 수 있는 심볼이 없습니다.\n${metaLine(skipped)}`;
      const lines = analyses.map(
        (a) => `${a.m.symbol}: last=${fmt(a.m.price)} prevClose=${fmt(a.m.prevClose)} change=${signed(+a.m.changePct.toFixed(2))}% momentum20d=${signed(a.momentumPct)}%`,
      );
      return [...lines, metaLine(skipped)].join("\n");
    },
  },
  {
    name: "us_news_sentiment",
    description:
      "News sentiment for the US tickers in the query: lexicon-scored Google News headlines with the evidence words that produced each score, plus a confidence-weighted aggregate per symbol. Deterministic — no LLM in the loop.",
    inputSchema: QUERY_SCHEMA("Free text naming US tickers, e.g. 'TSLA news sentiment'"),
    handler: async (query) => {
      const { analyses, skipped } = await analyzeQuery(query);
      if (analyses.length === 0) return `데이터를 가져올 수 있는 심볼이 없습니다.\n${metaLine(skipped)}`;
      const sections = analyses.map((a) => {
        const lines = a.news.map(
          (h) => `  [${labelOf(h.score)} ${signed(h.score)} conf=${h.confidence}] "${h.title.slice(0, 100)}" (${h.source})${h.hits.length ? ` — ${h.hits.join(",")}` : ""}`,
        );
        return [`${a.m.symbol}: aggregate ${labelOf(a.sentScore)} ${signed(a.sentScore)} (${a.news.length} headlines)`, ...(lines.length ? lines : ["  (no headlines found)"])].join("\n");
      });
      return [...sections, metaLine(skipped)].join("\n\n");
    },
  },
  {
    name: "us_rebalance_draft",
    description:
      "DRAFT rebalance proposal (never an order — this worker has no account or order capability): target weights proportional to positive blended alpha across the tickers in the query, with the full per-symbol reasoning. Weights cap at 25% per symbol.",
    inputSchema: QUERY_SCHEMA("Free text naming the US tickers to weigh, e.g. 'NVDA AAPL TSLA MSFT'"),
    handler: async (query) => {
      const { analyses, skipped } = await analyzeQuery(query);
      if (analyses.length === 0) return `데이터를 가져올 수 있는 심볼이 없습니다.\n${metaLine(skipped)}`;
      const CAP = 25;
      const positive = analyses.filter((a) => a.ensemble > 0.05);
      const sumPos = positive.reduce((acc, a) => acc + a.ensemble, 0);
      const rows = analyses
        .slice()
        .sort((x, y) => y.ensemble - x.ensemble)
        .map((a) => {
          const target = a.ensemble > 0.05 && sumPos > 0 ? Math.min(CAP, (a.ensemble / sumPos) * Math.min(100, CAP * positive.length)) : 0;
          return `  ${a.m.symbol}: target ${target.toFixed(1)}% — alpha ${signed(a.ensemble)} (tech ${signed(a.techAlpha)}·${a.techConf}, sent ${signed(a.sentScore)}·${a.sentConf}), RSI ${a.rsi}, mom20d ${signed(a.momentumPct)}%`;
        });
      const cash = 100 - analyses.reduce((acc, a) => acc + (a.ensemble > 0.05 && sumPos > 0 ? Math.min(CAP, (a.ensemble / sumPos) * Math.min(100, CAP * positive.length)) : 0), 0);
      return [
        `# Rebalance DRAFT (proposal only — no order capability exists in this worker)`,
        ...rows,
        `  cash / unallocated: ${Math.max(0, cash).toFixed(1)}%`,
        `method: weights ∝ positive blended alpha, ${CAP}% per-symbol cap; alpha = confidence-weighted blend of RSI-reversion+momentum technicals and lexicon news sentiment.`,
        metaLine(skipped),
      ].join("\n");
    },
  },
];

// ===== JSON-RPC =====

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// Vercel Node.js 서버리스 함수 시그니처 (의존성 없이 any로 받는다)
export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      name: "us-trading-mcp-worker",
      protocol: "MCP Streamable HTTP (POST JSON-RPC)",
      readOnly: true,
      tools: TOOLS.map((t) => t.name),
      note: "Read-only market analysis worker for Handsel offices. No account/order capability. Trading lives in the private backend.",
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const required = process.env.MCP_AUTH_TOKEN;
  if (required && req.headers.authorization !== `Bearer ${required}`) {
    return res.status(401).json(rpcError(null, -32001, "unauthorized"));
  }

  const body = req.body ?? {};
  const msg = Array.isArray(body) ? body[0] : body;
  if (!msg || typeof msg.method !== "string") return res.status(400).json(rpcError(null, -32600, "invalid request"));

  switch (msg.method) {
    case "initialize":
      res.setHeader("Mcp-Session-Id", Math.random().toString(36).slice(2));
      return res.status(200).json(
        rpcResult(msg.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "us-trading-mcp-worker", version: "1.0.0", title: "US Trading Desk — read-only analyst" },
        }),
      );
    case "notifications/initialized":
      return res.status(202).end();
    case "ping":
      return res.status(200).json(rpcResult(msg.id, {}));
    case "tools/list":
      return res.status(200).json(
        rpcResult(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }),
      );
    case "tools/call": {
      const params = msg.params ?? {};
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return res.status(200).json(rpcError(msg.id, -32602, `unknown tool: ${params.name}`));
      const query = typeof params.arguments?.query === "string" ? params.arguments.query : "";
      try {
        const text = await tool.handler(query);
        return res.status(200).json(rpcResult(msg.id, { content: [{ type: "text", text }], isError: false }));
      } catch (e) {
        return res
          .status(200)
          .json(rpcResult(msg.id, { content: [{ type: "text", text: `tool error: ${(e as Error).message}` }], isError: true }));
      }
    }
    default:
      if (msg.id === undefined) return res.status(202).end();
      return res.status(200).json(rpcError(msg.id, -32601, `method not found: ${msg.method}`));
  }
}
