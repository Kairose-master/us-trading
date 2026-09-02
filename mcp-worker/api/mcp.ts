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

// Vercel Node 런타임 전역 — @types/node 없이 빌드하므로 최소 선언
declare const process: { env: Record<string, string | undefined> };

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

// ===== 지표 계산 =====

// ===== 퀀트 코어 (backend/src/quant/{regime,garch}.ts와 동일 로직) — RSI 같은 장난감 지표 대신 =====

function hmmFit(returns: number[], k = 3, maxIters = 80): { states: Array<{ mu: number; sigma: number; label: string }>; current: number[] } {
  const n = returns.length;
  const FLOOR = 1e-5;
  const gauss = (y: number, mu: number, sigma: number) => {
    const s = Math.max(sigma, FLOOR);
    const z = (y - mu) / s;
    return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
  };
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / n);
  let states = [mean + 0.3 * sd, mean - 0.3 * sd, mean].slice(0, k).map((mu, i) => ({ mu, sigma: Math.max([0.7, 1.0, 2.0][i] * sd, FLOOR) }));
  let A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 0.9 : 0.1 / (k - 1))));
  let pi0 = new Array<number>(k).fill(1 / k);
  let logLik = -Infinity;
  const alpha = Array.from({ length: n }, () => new Array<number>(k).fill(0));
  const beta = Array.from({ length: n }, () => new Array<number>(k).fill(0));
  const scale = new Array<number>(n).fill(0);
  for (let it = 0; it < maxIters; it++) {
    const B = returns.map((y) => states.map((st) => Math.max(gauss(y, st.mu, st.sigma), 1e-300)));
    let c = 0;
    for (let i = 0; i < k; i++) { alpha[0][i] = pi0[i] * B[0][i]; c += alpha[0][i]; }
    scale[0] = c;
    for (let i = 0; i < k; i++) alpha[0][i] /= c;
    for (let t = 1; t < n; t++) {
      c = 0;
      for (let j = 0; j < k; j++) { let sm = 0; for (let i = 0; i < k; i++) sm += alpha[t - 1][i] * A[i][j]; alpha[t][j] = sm * B[t][j]; c += alpha[t][j]; }
      scale[t] = c;
      for (let j = 0; j < k; j++) alpha[t][j] /= c;
    }
    const ll = scale.reduce((a, v) => a + Math.log(v), 0);
    for (let i = 0; i < k; i++) beta[n - 1][i] = 1;
    for (let t = n - 2; t >= 0; t--) for (let i = 0; i < k; i++) { let sm = 0; for (let j = 0; j < k; j++) sm += A[i][j] * B[t + 1][j] * beta[t + 1][j]; beta[t][i] = sm / scale[t + 1]; }
    const gammaSum = new Array<number>(k).fill(0), muNum = new Array<number>(k).fill(0), gammaSumNoLast = new Array<number>(k).fill(0);
    const xiNum = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const gamma = Array.from({ length: n }, () => new Array<number>(k).fill(0));
    for (let t = 0; t < n; t++) {
      let norm = 0;
      for (let i = 0; i < k; i++) { gamma[t][i] = alpha[t][i] * beta[t][i]; norm += gamma[t][i]; }
      for (let i = 0; i < k; i++) { gamma[t][i] /= norm; gammaSum[i] += gamma[t][i]; muNum[i] += gamma[t][i] * returns[t]; if (t < n - 1) gammaSumNoLast[i] += gamma[t][i]; }
    }
    for (let t = 0; t < n - 1; t++) for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) xiNum[i][j] += (alpha[t][i] * A[i][j] * B[t + 1][j] * beta[t + 1][j]) / scale[t + 1];
    pi0 = gamma[0].slice();
    A = xiNum.map((row, i) => row.map((v) => v / Math.max(gammaSumNoLast[i], 1e-12)));
    states = states.map((_, i) => {
      const mu = muNum[i] / Math.max(gammaSum[i], 1e-12);
      let varr = 0;
      for (let t = 0; t < n; t++) varr += gamma[t][i] * (returns[t] - mu) ** 2;
      return { mu, sigma: Math.max(Math.sqrt(varr / Math.max(gammaSum[i], 1e-12)), FLOOR) };
    });
    if (Math.abs(ll - logLik) < 1e-7 * Math.abs(ll)) { logLik = ll; break; }
    logLik = ll;
  }
  // 포워드 필터 (예측→관측→갱신) — 마지막 belief
  let belief = pi0.slice();
  for (let t = 0; t < n; t++) {
    const pred = new Array<number>(k).fill(0);
    if (t === 0) for (let i = 0; i < k; i++) pred[i] = pi0[i];
    else for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) pred[j] += belief[i] * A[i][j];
    let norm = 0;
    const upd = pred.map((p, i) => { const v = p * Math.max(gauss(returns[t], states[i].mu, states[i].sigma), 1e-300); norm += v; return v; });
    belief = upd.map((v) => v / norm);
  }
  const maxSigma = Math.max(...states.map((st) => st.sigma));
  return {
    states: states.map((st) => ({ ...st, label: st.sigma === maxSigma && k > 2 ? "고변동" : st.mu >= 0 ? "강세" : "약세" })),
    current: belief.map((v) => +v.toFixed(4)),
  };
}

function garchForecastSigma(returns: number[], maxEvals = 300): { forecastSigma: number; persistence: number } {
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const eps = returns.map((r) => r - mean);
  const uncondVar = eps.reduce((a, e) => a + e * e, 0) / n;
  const nll = (omega: number, a: number, b: number) => {
    let v = uncondVar, s = 0;
    const sig = new Array<number>(n);
    for (let t = 0; t < n; t++) { if (t > 0) v = omega + a * eps[t - 1] * eps[t - 1] + b * v; v = Math.max(v, 1e-12); sig[t] = v; s += Math.log(v) + (eps[t] * eps[t]) / v; }
    return { s, lastVar: sig[n - 1] };
  };
  let best = { omega: uncondVar * 0.05, alpha: 0.08, beta: 0.88 };
  let bestNll = nll(best.omega, best.alpha, best.beta).s;
  let evals = 1, step = 0.5;
  const clamp = (p: typeof best) => ({ omega: Math.max(1e-12, p.omega), alpha: Math.min(0.5, Math.max(0, p.alpha)), beta: Math.min(0.998, Math.max(0, p.beta)) });
  while (evals < maxEvals && step > 1e-4) {
    let improved = false;
    const moves: Array<(p: typeof best, d: 1 | -1) => typeof best> = [
      (p, d) => ({ ...p, omega: p.omega * (d === 1 ? 1 + step : 1 / (1 + step)) }),
      (p, d) => ({ ...p, alpha: p.alpha + d * 0.05 * step }),
      (p, d) => ({ ...p, beta: p.beta + d * 0.05 * step }),
    ];
    for (const mv of moves) for (const d of [1, -1] as const) {
      const cand = clamp(mv(best, d));
      if (cand.alpha + cand.beta >= 0.999) continue;
      const r = nll(cand.omega, cand.alpha, cand.beta).s; evals++;
      if (r < bestNll - 1e-10) { bestNll = r; best = cand; improved = true; }
    }
    if (!improved) step *= 0.5;
  }
  const { lastVar } = nll(best.omega, best.alpha, best.beta);
  const lastEps = eps[n - 1];
  return { forecastSigma: Math.sqrt(best.omega + best.alpha * lastEps * lastEps + best.beta * lastVar), persistence: +(best.alpha + best.beta).toFixed(3) };
}

/** 종가열 → 레짐 belief + GARCH σ. 60개 미만이면 null (지어내지 않는다) */
function regimeView(closes: number[]): { pBull: number; pBear: number; label: string; garchSigmaPct: number; persistence: number } | null {
  if (closes.length < 61) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const r = rets.slice(-200);
  const hmm = hmmFit(r, 3);
  const bull = hmm.states.reduce((b, st, i) => (st.mu > hmm.states[b].mu ? i : b), 0);
  const bear = hmm.states.reduce((b, st, i) => (st.mu < hmm.states[b].mu ? i : b), 0);
  const g = garchForecastSigma(r);
  return {
    pBull: hmm.current[bull],
    pBear: hmm.current[bear],
    label: hmm.states[hmm.current.indexOf(Math.max(...hmm.current))].label,
    garchSigmaPct: +(g.forecastSigma * 100).toFixed(3),
    persistence: g.persistence,
  };
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
  /** HMM 레짐 belief (없으면 null — 데이터 부족) */
  regime: { pBull: number; pBear: number; label: string; garchSigmaPct: number; persistence: number } | null;
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
  const regime = regimeView(m.closes);
  const momentumPct =
    m.closes.length > 20 ? +(((m.closes[m.closes.length - 1] - m.closes[m.closes.length - 21]) / m.closes[m.closes.length - 21]) * 100).toFixed(2) : 0;
  const volPct = +stdevPct(m.closes.slice(-60)).toFixed(3);
  // 기술 알파 = 레짐 belief(강세−약세) + 모멘텀 팩터. RSI 없음.
  const regimeSig = regime ? regime.pBull - regime.pBear : 0;
  const momSig = Math.tanh(momentumPct / 10);
  const techAlpha = +Math.tanh(0.6 * regimeSig + 0.4 * momSig).toFixed(3);
  const techConf = +Math.max(0.1, 1 - Math.min(1, (regime?.garchSigmaPct ?? volPct) / 5)).toFixed(2);

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
  return { m, regime, momentumPct, volPct, techAlpha, techConf, news, sentScore, sentConf, ensemble };
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
      "Full analyst report for the US tickers in the query (default NVDA/AAPL/TSLA/MSFT): live price, HMM regime belief (P(bull)/P(bear), filtered), GARCH next-day volatility, 20-day momentum factor, news sentiment with evidence words, and a blended alpha per symbol — no RSI-style indicators. Every number is computed from live Yahoo Finance and Google News data at call time; symbols without data are skipped, never invented.",
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
          `  regime (HMM 3-state, filtered): P(bull)=${a.regime?.pBull ?? "n/a"} P(bear)=${a.regime?.pBear ?? "n/a"} [${a.regime?.label ?? "insufficient data"}] · GARCH σ_next=${a.regime?.garchSigmaPct ?? "n/a"}%/d (persistence ${a.regime?.persistence ?? "n/a"})`,
          `  factors: momentum20d=${signed(a.momentumPct)}% realizedVol(daily)=${a.volPct}% → techAlpha=${signed(a.techAlpha)} (conf ${a.techConf})`,
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
          return `  ${a.m.symbol}: target ${target.toFixed(1)}% — alpha ${signed(a.ensemble)} (tech ${signed(a.techAlpha)}·${a.techConf}, sent ${signed(a.sentScore)}·${a.sentConf}), P(bull) ${a.regime?.pBull ?? "n/a"}, GARCH σ ${a.regime?.garchSigmaPct ?? "n/a"}%/d, mom20d ${signed(a.momentumPct)}%`;
        });
      const cash = 100 - analyses.reduce((acc, a) => acc + (a.ensemble > 0.05 && sumPos > 0 ? Math.min(CAP, (a.ensemble / sumPos) * Math.min(100, CAP * positive.length)) : 0), 0);
      return [
        `# Rebalance DRAFT (proposal only — no order capability exists in this worker)`,
        ...rows,
        `  cash / unallocated: ${Math.max(0, cash).toFixed(1)}%`,
        `method: weights ∝ positive blended alpha, ${CAP}% per-symbol cap; alpha = confidence-weighted blend of HMM regime belief + momentum factor (no RSI) and lexicon news sentiment.`,
        metaLine(skipped),
      ].join("\n");
    },
  },
];

// ===== 크립토 (Upbit — 공개 API, 키 불필요) =====

const COINS = ["BTC", "ETH", "XRP", "SOL", "DOGE"];

function extractCoins(query: string): string[] {
  const up = query.toUpperCase();
  const found = COINS.filter((c) => new RegExp(`\\b${c}\\b`).test(up));
  return found.length > 0 ? found : ["BTC", "ETH"];
}

interface UpbitCandle {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function upbitTickers(coins: string[]): Promise<Array<{ market: string; price: number; changePct: number; high: number; low: number; vol24h: number }>> {
  const markets = coins.map((c) => `KRW-${c}`).join(",");
  const res = await fetch(`https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(markets)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{ market: string; trade_price: number; signed_change_rate: number; high_price: number; low_price: number; acc_trade_volume_24h: number }>;
  return data.map((t) => ({
    market: t.market,
    price: t.trade_price,
    changePct: +(t.signed_change_rate * 100).toFixed(2),
    high: t.high_price,
    low: t.low_price,
    vol24h: t.acc_trade_volume_24h,
  }));
}

async function upbitDayCandles(market: string, n: number): Promise<UpbitCandle[]> {
  const out: UpbitCandle[] = [];
  let to: string | null = null;
  while (out.length < n) {
    const count = Math.min(200, n - out.length);
    const toParam: string = to ? `&to=${encodeURIComponent(to)}` : "";
    const res = await fetch(`https://api.upbit.com/v1/candles/days?market=${market}&count=${count}${toParam}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) break;
    const batch = (await res.json()) as Array<{ candle_date_time_utc: string; opening_price: number; high_price: number; low_price: number; trade_price: number; candle_acc_trade_volume: number }>;
    if (batch.length === 0) break;
    out.push(
      ...batch.map((c) => ({ t: c.candle_date_time_utc.slice(0, 10), o: c.opening_price, h: c.high_price, l: c.low_price, c: c.trade_price, v: c.candle_acc_trade_volume })),
    );
    to = batch[batch.length - 1].candle_date_time_utc;
    if (batch.length < count) break;
  }
  return out.reverse();
}

// 백테스트 (backend/src/crypto/backtest.ts와 동일 로직·규약: 룩어헤드 없음, 롱/현금만)
function maAt(vals: number[], end: number, period: number): number {
  if (end + 1 < period) return NaN;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) s += vals[i];
  return s / period;
}

function rvAt(closes: number[], end: number, period: number): number {
  if (end + 1 < period + 1) return NaN;
  const rets: number[] = [];
  for (let i = end - period + 1; i <= end; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
}

const CRYPTO_SIGNALS: Array<{ id: string; name: string; position: (cs: UpbitCandle[], i: number) => 0 | 1 }> = [
  {
    id: "momentum-20",
    name: "20-day momentum trend",
    position: (cs, i) => {
      const m = maAt(cs.map((c) => c.c), i, 20);
      return !Number.isNaN(m) && cs[i].c > m ? 1 : 0;
    },
  },
  {
    id: "vol-regime",
    name: "Volatility regime filter",
    position: (cs, i) => {
      const closes = cs.map((c) => c.c);
      const s = rvAt(closes, i, 10);
      const l = rvAt(closes, i, 60);
      return !Number.isNaN(s) && !Number.isNaN(l) && s < l * 0.9 ? 1 : 0;
    },
  },
];

// 비용: 업비트 현물 수수료 0.05% + 슬리피지 가정 0.05%/편도 — 백엔드 DEFAULT_COSTS와 동일
const BT_COST_RATE = (0.05 + 0.05) / 100;

function runCryptoBacktest(cs: UpbitCandle[], sig: (typeof CRYPTO_SIGNALS)[number]) {
  let eq = 1;
  let eqGross = 1;
  let bench = 1;
  let peak = 1;
  let maxDd = 0;
  let wins = 0;
  let held = 0;
  let trades = 0;
  let prev: 0 | 1 = 0;
  const rets: number[] = [];
  for (let i = 0; i < cs.length - 1; i++) {
    const pos = sig.position(cs, i);
    if (pos === 1 && prev === 0) trades++;
    const turnover = Math.abs(pos - prev);
    prev = pos;
    const r = cs[i + 1].c / cs[i].c - 1;
    const gross = pos === 1 ? r : 0;
    const sr = gross - turnover * BT_COST_RATE;
    eq *= 1 + sr;
    eqGross *= 1 + gross;
    bench *= 1 + r;
    rets.push(sr);
    if (pos === 1) {
      held++;
      if (sr > 0) wins++;
    }
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  if (prev === 1) eq *= 1 - BT_COST_RATE; // 종료 시점 보유분 청산 비용
  const years = (cs.length - 1) / 365;
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length));
  return {
    annualPct: years > 0 ? +((Math.pow(eq, 1 / years) - 1) * 100).toFixed(2) : 0,
    benchPct: +((bench - 1) * 100).toFixed(2),
    sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(365)).toFixed(2) : 0,
    mddPct: +(-maxDd * 100).toFixed(2),
    winRatePct: held > 0 ? +((wins / held) * 100).toFixed(1) : 0,
    trades,
    exposurePct: +((held / Math.max(1, cs.length - 1)) * 100).toFixed(1),
    costDragPct: +((eqGross - eq) * 100).toFixed(2),
  };
}

const CRYPTO_TOOLS: ToolDef[] = [
  {
    name: "upbit_price_lookup",
    description:
      "Live Upbit KRW-market quotes for the coins in the query (BTC/ETH/XRP/SOL/DOGE): price, 24h change, high/low, volume. Real public Upbit data at call time.",
    inputSchema: QUERY_SCHEMA("Free text naming coins, e.g. 'BTC ETH price'"),
    handler: async (query) => {
      const rows = await upbitTickers(extractCoins(query));
      if (rows.length === 0) return `Upbit 시세를 가져오지 못했습니다.\n${metaLine([])}`;
      const lines = rows.map(
        (q) => `${q.market}: ₩${q.price.toLocaleString()} (${q.changePct >= 0 ? "+" : ""}${q.changePct}%) high=₩${q.high.toLocaleString()} low=₩${q.low.toLocaleString()} vol24h=${q.vol24h.toFixed(2)}`,
      );
      return [...lines, `[data] Upbit public API · ts=${new Date().toISOString()}`].join("\n");
    },
  },
  {
    name: "upbit_market_report",
    description:
      "Crypto analyst report for the coins in the query (default BTC/ETH): live Upbit price, trend read vs MA20, 30-day support/resistance levels with the exact price AND date they printed, momentum call, HMM regime belief (P(bull)/P(bear)) and GARCH next-day volatility — all from real daily candles, no RSI-style indicators — plus lexicon-scored crypto news headlines each cited with date and source. Nothing invented.",
    inputSchema: QUERY_SCHEMA("Free text naming coins, e.g. 'BTC SOL outlook'"),
    handler: async (query) => {
      const coins = extractCoins(query).slice(0, 3);
      const sections = await Promise.all(
        coins.map(async (coin) => {
          const market = `KRW-${coin}`;
          const [candles, tickers, newsRes] = await Promise.all([
            upbitDayCandles(market, 90),
            upbitTickers([coin]),
            fetch(
              `https://news.google.com/rss/search?q=${encodeURIComponent(`${coin} crypto`)}&hl=en-US&gl=US&ceid=US:en`,
              { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
            ).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
          ]);
          if (candles.length < 21 || tickers.length === 0) return `## ${market} — no data (skipped, not invented)`;
          const closes = candles.map((c) => c.c);
          const rg = regimeView(closes);
          const mom = +(((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100).toFixed(2);
          const vol = +stdevPct(closes.slice(-60)).toFixed(3);
          // 지지/저항: 최근 30일 실캔들의 최저 저가/최고 고가 — 가격과 그 날짜를 그대로 인용
          const last30 = candles.slice(-30);
          const sup = last30.reduce((a, c) => (c.l < a.l ? c : a), last30[0]);
          const res30 = last30.reduce((a, c) => (c.h > a.h ? c : a), last30[0]);
          const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
          const lastC = candles[candles.length - 1];
          const from = candles[candles.length - 21];
          const heads: string[] = [];
          let sSum = 0;
          let sDen = 0;
          const itemRe = /<item>([\s\S]*?)<\/item>/g;
          let m: RegExpExecArray | null;
          while ((m = itemRe.exec(newsRes)) !== null && heads.length < 5) {
            const t = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "")
              .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
              .replace(/ - [^-]+$/, "")
              .trim();
            if (!t) continue;
            const src = (/<source[^>]*>([\s\S]*?)<\/source>/.exec(m[1])?.[1] ?? "GoogleNews").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
            const pub = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1])?.[1]?.trim() ?? "";
            const pubDate = pub ? new Date(pub).toISOString().slice(0, 10) : "date n/a";
            const sc = scoreHeadline(t);
            sSum += sc.score * sc.confidence;
            sDen += sc.confidence;
            heads.push(`    · [${labelOf(sc.score)} ${signed(sc.score)}] "${t.slice(0, 90)}" — ${src}, ${pubDate}${sc.hits.length ? ` · evidence: ${sc.hits.join(",")}` : ""}`);
          }
          const agg = sDen > 0 ? +(sSum / sDen).toFixed(3) : 0;
          const tk = tickers[0];
          return [
            `## ${market} — ₩${tk.price.toLocaleString()} (${tk.changePct >= 0 ? "+" : ""}${tk.changePct}% 24h)`,
            `  trend: close ₩${lastC.c.toLocaleString()} (${lastC.t}) is ${lastC.c > ma20 ? "ABOVE" : "BELOW"} MA20 ₩${Math.round(ma20).toLocaleString()} → ${lastC.c > ma20 ? "uptrend bias" : "downtrend bias"}`,
            `  support (30d low): ₩${sup.l.toLocaleString()} printed ${sup.t} · resistance (30d high): ₩${res30.h.toLocaleString()} printed ${res30.t}`,
            `  momentum call: ${mom >= 0 ? "positive" : "negative"} — close moved ₩${from.c.toLocaleString()} (${from.t}) → ₩${lastC.c.toLocaleString()} (${lastC.t}), ${signed(mom)}% over 20 sessions`,
            `  regime (HMM 3-state, filtered on ${Math.min(200, closes.length - 1)} daily returns): P(bull)=${rg?.pBull ?? "n/a"} P(bear)=${rg?.pBear ?? "n/a"} [${rg?.label ?? "insufficient data"}] · GARCH σ_next=${rg?.garchSigmaPct ?? "n/a"}%/d (persistence ${rg?.persistence ?? "n/a"}) · realizedVol(daily)=${vol}%`,
            `  news sentiment: ${labelOf(agg)} ${signed(agg)} (${heads.length} headlines${heads.length === 0 ? " — nothing material found in a genuine Google News search" : ""})`,
            ...heads,
          ].join("\n");
        }),
      );
      return [`# Upbit crypto report`, ...sections, `[data] Upbit public API + Google News RSS · lexicon-scored · ts=${new Date().toISOString()}`].join("\n\n");
    },
  },
  {
    name: "upbit_rebalance_draft",
    description:
      "DRAFT portfolio weights across the coins in the query (never an order — no account/order capability): target weight per coin proportional to a confidence-weighted blend of HMM regime belief + 20d momentum factor (GARCH-volatility confidence, no RSI) and dated news sentiment, 40% per-coin cap, remainder in cash. Every weight cites the exact technical and sentiment numbers (with dates) it is derived from. Real Upbit candles + Google News at call time.",
    inputSchema: QUERY_SCHEMA("Coins to weigh, e.g. 'BTC ETH SOL'"),
    handler: async (query) => {
      const coins = extractCoins(query).slice(0, 5);
      const rows = await Promise.all(
        coins.map(async (coin) => {
          const market = `KRW-${coin}`;
          const [candles, newsRes] = await Promise.all([
            upbitDayCandles(market, 90),
            fetch(
              `https://news.google.com/rss/search?q=${encodeURIComponent(`${coin} crypto`)}&hl=en-US&gl=US&ceid=US:en`,
              { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
            ).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
          ]);
          if (candles.length < 21) return null;
          const closes = candles.map((c) => c.c);
          const rg = regimeView(closes);
          const mom = +(((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100).toFixed(2);
          const vol = +stdevPct(closes.slice(-60)).toFixed(3);
          const regimeSig = rg ? rg.pBull - rg.pBear : 0;
          const momSig = Math.tanh(mom / 10);
          const techAlpha = +Math.tanh(0.6 * regimeSig + 0.4 * momSig).toFixed(3);
          const techConf = +Math.max(0.1, 1 - Math.min(1, (rg?.garchSigmaPct ?? vol) / 5)).toFixed(2);
          let sSum = 0;
          let sDen = 0;
          let headCount = 0;
          const itemRe = /<item>([\s\S]*?)<\/item>/g;
          let m: RegExpExecArray | null;
          while ((m = itemRe.exec(newsRes)) !== null && headCount < 8) {
            const t = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
            if (!t) continue;
            headCount++;
            const sc = scoreHeadline(t);
            sSum += sc.score * sc.confidence;
            sDen += sc.confidence;
          }
          const sent = sDen > 0 ? +(sSum / sDen).toFixed(3) : 0;
          const sentConf = +Math.min(1, sDen / 3).toFixed(2);
          const wSum = techConf + sentConf;
          const alpha = wSum > 0 ? +((techAlpha * techConf + sent * sentConf) / wSum).toFixed(3) : 0;
          const lastC = candles[candles.length - 1];
          const from = candles[candles.length - 21];
          return { market, alpha, techAlpha, techConf, sent, sentConf, rg, mom, lastC, from, headCount };
        }),
      );
      const ok = rows.filter((r): r is NonNullable<typeof r> => r !== null);
      if (ok.length === 0) return `데이터를 가져올 수 있는 코인이 없습니다.\n[data] Upbit public API`;
      const CAP = 40;
      const positive = ok.filter((r) => r.alpha > 0.05);
      const sumPos = positive.reduce((a, r) => a + r.alpha, 0);
      const lines = ok
        .slice()
        .sort((x, y) => y.alpha - x.alpha)
        .map((r) => {
          const target = r.alpha > 0.05 && sumPos > 0 ? Math.min(CAP, (r.alpha / sumPos) * Math.min(100, CAP * positive.length)) : 0;
          return [
            `  ${r.market}: target ${target.toFixed(1)}% — blended alpha ${signed(r.alpha)}`,
            `    based on CHART: HMM P(bull)=${r.rg?.pBull ?? "n/a"} P(bear)=${r.rg?.pBear ?? "n/a"} [${r.rg?.label ?? "n/a"}], GARCH σ_next=${r.rg?.garchSigmaPct ?? "n/a"}%/d, momentum ₩${r.from.c.toLocaleString()} (${r.from.t}) → ₩${r.lastC.c.toLocaleString()} (${r.lastC.t}) = ${signed(r.mom)}% → techAlpha ${signed(r.techAlpha)} (conf ${r.techConf})`,
            `    based on NEWS: sentiment ${labelOf(r.sent)} ${signed(r.sent)} from ${r.headCount} scored headlines (conf ${r.sentConf})`,
          ].join("\n");
        });
      const alloc = ok.reduce((a, r) => a + (r.alpha > 0.05 && sumPos > 0 ? Math.min(CAP, (r.alpha / sumPos) * Math.min(100, CAP * positive.length)) : 0), 0);
      return [
        `# Crypto rebalance DRAFT (proposal only — no order capability exists in this worker)`,
        ...lines,
        `  cash / unallocated: ${Math.max(0, 100 - alloc).toFixed(1)}%`,
        `method: weights ∝ positive blended alpha (HMM regime + momentum factor techAlpha, GARCH-vol confidence; + news sentiment), ${CAP}% per-coin cap. No RSI.`,
        `[data] Upbit public API + Google News RSS · ts=${new Date().toISOString()}`,
      ].join("\n");
    },
  },
  {
    name: "upbit_news_report",
    description:
      "News desk for the coins in the query (default BTC/ETH): Google News RSS headlines per coin, each cited with source and publish date, lexicon-scored with the evidence words, plus a per-coin aggregate. States 'nothing material found' explicitly when a genuine search returns nothing. No price analysis here — that is the chart desk.",
    inputSchema: QUERY_SCHEMA("Coins, e.g. 'BTC ETH SOL news'"),
    handler: async (query) => {
      const coins = extractCoins(query).slice(0, 5);
      const sections = await Promise.all(
        coins.map(async (coin) => {
          const market = `KRW-${coin}`;
          const xml = await fetch(
            `https://news.google.com/rss/search?q=${encodeURIComponent(`${coin} crypto`)}&hl=en-US&gl=US&ceid=US:en`,
            { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
          ).then((r) => (r.ok ? r.text() : "")).catch(() => "");
          const lines: string[] = [];
          let sSum = 0;
          let sDen = 0;
          const itemRe = /<item>([\s\S]*?)<\/item>/g;
          let m: RegExpExecArray | null;
          while ((m = itemRe.exec(xml)) !== null && lines.length < 8) {
            const t = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "")
              .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
              .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
              .replace(/ - [^-]+$/, "")
              .trim();
            if (!t) continue;
            const src = (/<source[^>]*>([\s\S]*?)<\/source>/.exec(m[1])?.[1] ?? "GoogleNews").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
            const pub = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1])?.[1]?.trim() ?? "";
            const pubDate = pub ? new Date(pub).toISOString().slice(0, 10) : "date n/a";
            const link = (/<link>([\s\S]*?)<\/link>/.exec(m[1])?.[1] ?? "").trim();
            const sc = scoreHeadline(t);
            sSum += sc.score * sc.confidence;
            sDen += sc.confidence;
            lines.push(`  · [${labelOf(sc.score)} ${signed(sc.score)} conf ${sc.confidence}] "${t.slice(0, 110)}" — ${src}, ${pubDate}${sc.hits.length ? ` · evidence: ${sc.hits.join(",")}` : ""}${link ? ` · ${link.slice(0, 80)}` : ""}`);
          }
          const agg = sDen > 0 ? +(sSum / sDen).toFixed(3) : 0;
          return [
            `## ${market} — ${lines.length ? `${lines.length} headlines, aggregate ${labelOf(agg)} ${signed(agg)}` : "nothing material found in a genuine Google News search (not invented)"}`,
            ...lines,
          ].join("\n");
        }),
      );
      return [`# Crypto news desk`, ...sections, `[data] Google News RSS · deterministic lexicon (no LLM) · ts=${new Date().toISOString()}`].join("\n\n");
    },
  },
  {
    name: "upbit_quant_report",
    description:
      "Quant desk for the coins in the query (default BTC/ETH): per coin, a 3-state Gaussian HMM fitted by EM on up to 200 daily log returns with the filtered belief P(regime | returns so far) and transition matrix, GARCH(1,1) next-day volatility with persistence, historical VaR/ES/max drawdown, and fractional Kelly sizing (μ/σ²). Every number is fitted at call time from real Upbit candles — no RSI-style indicators. Sizing is a cap, not a recommendation.",
    inputSchema: QUERY_SCHEMA("Coins, e.g. 'BTC ETH SOL'"),
    handler: async (query) => {
      const coins = extractCoins(query).slice(0, 5);
      const sections = await Promise.all(
        coins.map(async (coin) => {
          const market = `KRW-${coin}`;
          const candles = await upbitDayCandles(market, 200).catch(() => [] as UpbitCandle[]);
          if (candles.length < 61) return `## ${market} — insufficient history (${candles.length} candles) — skipped, not invented`;
          const closes = candles.map((c) => c.c);
          const rets: number[] = [];
          for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
          const hmm = hmmFit(rets, 3);
          const g = garchForecastSigma(rets);
          // 리스크 (역사적) + Kelly
          const sorted = [...rets].sort((a, b) => a - b);
          const n = rets.length;
          const q = (p: number) => sorted[Math.max(0, Math.min(n - 1, Math.floor(n * p)))];
          const tail = sorted.slice(0, Math.max(1, Math.floor(n * 0.05)));
          const es95 = -tail.reduce((a, b) => a + b, 0) / tail.length;
          let eq = 1, peak = 1, mdd = 0;
          for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); }
          const mu = rets.reduce((a, b) => a + b, 0) / n;
          const varr = rets.reduce((a, r) => a + (r - mu) ** 2, 0) / n;
          const kelly = varr > 0 ? Math.min(1, Math.max(0, mu / varr)) : 0;
          const states = hmm.states.map((st, i) => `${st.label}(μ=${(st.mu * 100).toFixed(2)}%/d σ=${(st.sigma * 100).toFixed(2)}%) P=${hmm.current[i]}`).join(" · ");
          return [
            `## ${market} — ${candles[0].t} ~ ${candles[candles.length - 1].t} (${n} returns)`,
            `  HMM regime belief (filtered): ${states}`,
            `  GARCH(1,1): σ_next=${(g.forecastSigma * 100).toFixed(3)}%/d (annualized ${(g.forecastSigma * Math.sqrt(365) * 100).toFixed(1)}%) · persistence α+β=${g.persistence}`,
            `  risk (historical, daily): VaR95=${(-q(0.05) * 100).toFixed(2)}% VaR99=${(-q(0.01) * 100).toFixed(2)}% ES95=${(es95 * 100).toFixed(2)}% · maxDD=${(-mdd * 100).toFixed(1)}%`,
            `  Kelly (μ/σ², log-utility approx): full=${kelly.toFixed(3)} half=${(kelly / 2).toFixed(3)} — μ̂=${(mu * 100).toFixed(3)}%/d σ̂=${(Math.sqrt(varr) * 100).toFixed(2)}%/d · treat as an upper bound on exposure, not a signal`,
          ].join("\n");
        }),
      );
      return [`# Crypto quant desk`, ...sections, `[data] Upbit public API · HMM(EM)+GARCH(MLE)+historical risk fitted at call time · ts=${new Date().toISOString()}`].join("\n\n");
    },
  },
  {
    name: "upbit_backtest_report",
    description:
      "Run a REAL backtest on live Upbit daily candles (365d) and report annualized return vs buy&hold, Sharpe, max drawdown, win rate, trades per signal. Signals: momentum-20, vol-regime (regime/HMM signal lives in the backend backtest). No RSI-style indicators. Convention: signal at close t applies to t+1 return; long/cash only, no lookahead; fee 0.05% + slippage 0.05% per side included.",
    inputSchema: QUERY_SCHEMA("e.g. 'KRW-ETH momentum-20' or 'BTC all signals'"),
    handler: async (query) => {
      const coin = extractCoins(query)[0];
      const market = `KRW-${coin}`;
      const named = CRYPTO_SIGNALS.filter((s) => query.toLowerCase().includes(s.id));
      const signals = named.length > 0 ? named : CRYPTO_SIGNALS;
      const candles = await upbitDayCandles(market, 365);
      if (candles.length < 90) return `캔들 부족 (${candles.length}개) — 백테스트 불가\n[data] Upbit public API`;
      const rows = signals.map((s) => {
        const r = runCryptoBacktest(candles, s);
        return `  ${s.name} [${s.id}]: annual=${r.annualPct}% (B&H ${r.benchPct}%) sharpe=${r.sharpe} MDD=${r.mddPct}% winRate=${r.winRatePct}% trades=${r.trades} exposure=${r.exposurePct}% costDrag=${r.costDragPct}%p`;
      });
      return [
        `# Upbit backtest — ${market}, ${candles.length} daily candles (${candles[0].t} ~ ${candles[candles.length - 1].t})`,
        `convention: signal at close t → position for t+1 return; long/cash only (no lookahead, no shorting); costs: fee 0.05% + slippage 0.05% per side`,
        ...rows,
        `[data] Upbit public API · ts=${new Date().toISOString()}`,
      ].join("\n");
    },
  },
];

TOOLS.push(...CRYPTO_TOOLS);

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
      note: "Read-only market analysis worker for Handsel offices. US stocks + Upbit crypto. No account/order capability. Trading lives in the private backend.",
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
          serverInfo: { name: "us-trading-mcp-worker", version: "1.5.0", title: "US Trading Desk — read-only analyst (stocks + crypto)" },
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
