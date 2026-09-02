import { DEFAULT_COSTS, type BtCandle, type TradingCosts } from "./backtest.js";
import { backtestStats, type BacktestStats } from "../quant/stats.js";

/**
 * 알트코인 스캐너 — 업비트 KRW 전 마켓을 훑어 비용 차감 후 위험조정 점수로
 * 랭킹하고, 상위 K개 로테이션 포트폴리오를 만든다. 순수 함수 —
 * 프론트(lib/crypto/scanner.ts)와 동일 로직, 한쪽을 고치면 다른 쪽도 맞출 것.
 *
 * 정직성 원칙:
 *  - "수익 극대화"는 약속이 아니라 시도다. 여기서 극대화하는 것은
 *    비용 차감 후 위험조정 기대수익(횡단면 모멘텀/변동성)이고, 그 시도가
 *    과거에 통했는지는 rotationBacktest + 다중검정 보정으로만 판단한다.
 *  - N개 코인을 스캔하는 것 자체가 N번의 암묵적 검정이다 —
 *    strategiesTested에 유니버스 크기를 그대로 넣는다.
 *  - 랭킹 점수는 t 시점까지의 캔들만 본다. 로테이션 백테스트도 같은 규약
 *    (t 종가 점수 → t+1부터 적용, 룩어헤드 없음).
 */

export interface CoinScore {
  market: string; // "KRW-XXX"
  priceKrw: number;
  /** 24h 거래대금 (KRW) — 유동성 필터의 근거 */
  valueKrw24h: number;
  mom20Pct: number;
  mom60Pct: number;
  /** 20일 실현변동성 (일간, %) */
  vol20Pct: number;
  rsi14: number;
  /** 종가 > MA20 — 추세 필터 */
  aboveMa20: boolean;
  /** 위험조정 모멘텀 = mom20 / vol20 — 랭킹의 기준 점수 */
  score: number;
  days: number;
}

function rsiOf(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / period / (losses / period));
}

function realizedVolPct(closes: number[], period: number): number {
  if (closes.length < period + 1) return NaN;
  const rets: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) * 100;
}

/** 캔들(오름차순)에서 한 코인의 점수를 계산. 데이터 부족이면 null — 지어내지 않는다. */
export function scoreCoin(market: string, candles: BtCandle[], valueKrw24h: number): CoinScore | null {
  const n = candles.length;
  if (n < 61) return null;
  const closes = candles.map((c) => c.c);
  const last = closes[n - 1];
  const mom20 = (last / closes[n - 21] - 1) * 100;
  const mom60 = (last / closes[n - 61] - 1) * 100;
  const vol20 = realizedVolPct(closes, 20);
  if (!Number.isFinite(vol20) || vol20 <= 0) return null;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  return {
    market,
    priceKrw: last,
    valueKrw24h,
    mom20Pct: +mom20.toFixed(2),
    mom60Pct: +mom60.toFixed(2),
    vol20Pct: +vol20.toFixed(3),
    rsi14: +rsiOf(closes).toFixed(1),
    aboveMa20: last > ma20,
    score: +(mom20 / vol20).toFixed(3),
    days: n,
  };
}

export interface ScannerTarget {
  market: string;
  weightPct: number;
  /** 이 비중의 근거 — 점수/모멘텀/변동성 실측치 */
  why: string;
}

export interface ScannerPortfolio {
  targets: ScannerTarget[];
  cashPct: number;
  method: string;
}

export const SCANNER_DEFAULTS = { topK: 5, capPct: 25 };

/**
 * 상위 K 로테이션 타깃: 추세 필터(MA20 위) + 양(+)의 위험조정 모멘텀만,
 * 비중은 역변동성(1/vol) 가중 + 코인당 상한. 나머지는 현금 —
 * 자격 있는 코인이 없으면 100% 현금이 정답이고, 그걸 그대로 반환한다.
 */
export function buildTargets(
  scores: CoinScore[],
  opts: { topK?: number; capPct?: number } = {},
): ScannerPortfolio {
  const topK = opts.topK ?? SCANNER_DEFAULTS.topK;
  const capPct = opts.capPct ?? SCANNER_DEFAULTS.capPct;
  const eligible = scores
    .filter((s) => s.aboveMa20 && s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  const invVolSum = eligible.reduce((a, s) => a + 1 / s.vol20Pct, 0);
  const budget = Math.min(100, capPct * eligible.length);
  let targets = eligible.map((s) => ({
    market: s.market,
    weightPct: invVolSum > 0 ? Math.min(capPct, ((1 / s.vol20Pct) / invVolSum) * budget) : 0,
    why: `score ${s.score} (mom20 ${s.mom20Pct >= 0 ? "+" : ""}${s.mom20Pct}% / vol20 ${s.vol20Pct}%) · RSI ${s.rsi14} · MA20 위`,
  }));
  targets = targets.map((t) => ({ ...t, weightPct: +t.weightPct.toFixed(1) }));
  const alloc = targets.reduce((a, t) => a + t.weightPct, 0);
  return {
    targets,
    cashPct: +(100 - alloc).toFixed(1),
    method: `추세 필터(종가>MA20) + 위험조정 모멘텀(mom20/vol20) 상위 ${topK} · 역변동성 가중 · 코인당 ${capPct}% 상한 · 자격 없으면 현금`,
  };
}

// ===== 로테이션 백테스트 — 이 랭킹 규칙이 과거에 통했는가 =====

export interface RotationBacktestResult {
  universe: number;
  daysUsed: number;
  rebalanceDays: number;
  topK: number;
  capPct: number;
  costs: TradingCosts;
  equity: Array<{ t: string; strategy: number; benchmarkBtc: number; benchmarkEqual: number }>;
  metrics: {
    totalReturnPct: number;
    annualReturnPct: number;
    btcReturnPct: number;
    equalWeightReturnPct: number;
    maxDrawdownPct: number;
    costDragPct: number;
    avgPositions: number;
    rebalances: number;
  };
  stats: BacktestStats;
  caveat: string;
}

/**
 * 로테이션 규칙의 인샘플 백테스트. series는 마켓→일봉(오름차순).
 * 규약: t 종가까지의 데이터로 점수 → t+1 수익률부터 적용, 리밸런스일에만
 * 비중 변경, 턴오버 Σ|Δw|에 편도 비용 부과. 벤치마크는 KRW-BTC B&H와
 * 유니버스 동일가중 B&H 둘 다 — "알트 로테이션이 그냥 BTC 들고 있는 것보다
 * 나았는가"가 진짜 질문이기 때문.
 */
export function rotationBacktest(
  series: Map<string, BtCandle[]>,
  opts: { topK?: number; capPct?: number; rebalanceDays?: number; costs?: TradingCosts } = {},
): RotationBacktestResult | null {
  const topK = opts.topK ?? SCANNER_DEFAULTS.topK;
  const capPct = opts.capPct ?? SCANNER_DEFAULTS.capPct;
  const rebalanceDays = opts.rebalanceDays ?? 7;
  const costs = opts.costs ?? DEFAULT_COSTS;
  const costRate = (costs.feePct + costs.slipPct) / 100;

  // 날짜 축: 모든 코인의 날짜 합집합(정렬). 각 코인은 자기 데이터가 있는
  // 구간에서만 점수/수익률에 참여한다 (상장 시점이 제각각인 유니버스의 현실).
  const dateSet = new Set<string>();
  for (const cs of series.values()) for (const c of cs) dateSet.add(c.t);
  const dates = [...dateSet].sort();
  if (dates.length < 90) return null;
  const closeOf = new Map<string, Map<string, number>>(); // market → date → close
  for (const [m, cs] of series) closeOf.set(m, new Map(cs.map((c) => [c.t, c.c])));
  const markets = [...series.keys()];

  const WARMUP = 61;
  let eq = 1;
  let eqGross = 1;
  let btc = 1;
  let ew = 1;
  let peak = 1;
  let maxDd = 0;
  let rebalances = 0;
  let posDaysSum = 0;
  let pendingCostPct = 0;
  const weights = new Map<string, number>(); // 현재 비중 (0~1)
  const dailyRets: number[] = [];
  const equity: RotationBacktestResult["equity"] = [];

  for (let d = WARMUP; d < dates.length - 1; d++) {
    const t = dates[d];
    const t1 = dates[d + 1];

    // 리밸런스일: t 종가까지의 캔들로 점수 → 새 타깃
    if ((d - WARMUP) % rebalanceDays === 0) {
      const scores: CoinScore[] = [];
      for (const m of markets) {
        const cs = series.get(m)!;
        const upto = cs.filter((c) => c.t <= t);
        const sc = scoreCoin(m, upto, 0);
        if (sc) scores.push(sc);
      }
      const pf = buildTargets(scores, { topK, capPct });
      const next = new Map(pf.targets.map((x) => [x.market, x.weightPct / 100]));
      let turnover = 0;
      for (const m of new Set([...weights.keys(), ...next.keys()])) {
        turnover += Math.abs((next.get(m) ?? 0) - (weights.get(m) ?? 0));
      }
      if (turnover > 1e-9) {
        pendingCostPct = turnover * costRate;
        rebalances++;
      }
      weights.clear();
      for (const [m, w] of next) weights.set(m, w);
    }

    // t → t+1 수익률 적용 — 리밸런스 비용은 그날 수익률에서 직접 차감 (통계에도 반영)
    let ret = 0;
    for (const [m, w] of weights) {
      const c0 = closeOf.get(m)!.get(t);
      const c1 = closeOf.get(m)!.get(t1);
      if (c0 && c1) ret += w * (c1 / c0 - 1);
    }
    const stratRet = ret - pendingCostPct;
    pendingCostPct = 0;
    eq *= 1 + stratRet;
    eqGross *= 1 + ret; // 무비용 (드래그 계산용)
    dailyRets.push(stratRet);
    posDaysSum += weights.size;

    const b0 = closeOf.get("KRW-BTC")?.get(t);
    const b1 = closeOf.get("KRW-BTC")?.get(t1);
    if (b0 && b1) btc *= b1 / b0;
    let ewRet = 0;
    let ewN = 0;
    for (const m of markets) {
      const c0 = closeOf.get(m)!.get(t);
      const c1 = closeOf.get(m)!.get(t1);
      if (c0 && c1) {
        ewRet += c1 / c0 - 1;
        ewN++;
      }
    }
    if (ewN > 0) ew *= 1 + ewRet / ewN;

    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
    equity.push({ t: t1, strategy: +eq.toFixed(4), benchmarkBtc: +btc.toFixed(4), benchmarkEqual: +ew.toFixed(4) });
  }
  // 종료 시점 보유분 청산 비용
  const finalW = [...weights.values()].reduce((a, b) => a + b, 0);
  if (finalW > 0) eq *= 1 - finalW * costRate;

  const daysUsed = equity.length;
  if (daysUsed < 30) return null;
  const years = daysUsed / 365;
  const stats = backtestStats(dailyRets, markets.length);

  return {
    universe: markets.length,
    daysUsed,
    rebalanceDays,
    topK,
    capPct,
    costs,
    equity,
    metrics: {
      totalReturnPct: +((eq - 1) * 100).toFixed(2),
      annualReturnPct: years > 0 ? +((Math.pow(eq, 1 / years) - 1) * 100).toFixed(2) : 0,
      btcReturnPct: +((btc - 1) * 100).toFixed(2),
      equalWeightReturnPct: +((ew - 1) * 100).toFixed(2),
      maxDrawdownPct: +(-maxDd * 100).toFixed(2),
      costDragPct: +((eqGross - eq) * 100).toFixed(2),
      avgPositions: +(posDaysSum / daysUsed).toFixed(1),
      rebalances,
    },
    stats,
    caveat: `유니버스 ${markets.length}개 코인을 스캔한 것 자체가 ${markets.length}번의 암묵적 검정이다 — strategiesTested=${markets.length}로 Bonferroni 보정했고, 이 백테스트는 인샘플이라 실제 기대치의 상한선이다.`,
  };
}
