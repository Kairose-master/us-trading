import type { BtCandle } from "../crypto/backtest.js";
import { DEFAULT_COSTS } from "../crypto/backtest.js";
import { fitHmm } from "../quant/regime.js";
import type { Genes } from "./genome.js";

/**
 * 유전자 → 실캔들 워크포워드 평가.
 *
 * 시험(exam)은 "본 적 없는 데이터"로만 본다: HMM은 훈련 구간에서만 적합하고, 시험
 * 구간은 고정된 파라미터로 forward filter만 돌린다(미래 정보 없음). 점수는 t 종가까지의
 * 데이터로 계산해 t+1 수익률에 적용하고, 리밸런스 턴오버에 편도 비용을 물린다.
 * 모든 에이전트가 같은 시험지를 본다 — 적합도 비교가 공정하려면 그래야 한다.
 */

export interface MarketFeatures {
  market: string;
  dates: string[];
  closes: number[];
  logRets: number[]; // logRets[i] = log(c[i]/c[i-1]), i≥1 (index 0 = 0)
  pBull: number[]; // 필터된 P(강세 | 정보 ≤ t)
}

export interface FeatureSet {
  markets: MarketFeatures[];
  dates: string[]; // 공통 날짜 축 (전 마켓 합집합, 정렬)
  trainEnd: number; // dates 인덱스 — 이 이전이 훈련, 이후가 시험
}

function forwardFilter(rets: number[], states: Array<{ mu: number; sigma: number }>, A: number[][], init: number[]): number[][] {
  const k = states.length;
  const out: number[][] = [];
  let prev = init.slice();
  for (let t = 0; t < rets.length; t++) {
    const pred = new Array(k).fill(0);
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) pred[j] += prev[i] * A[i][j];
    const post = pred.map((p, j) => {
      const s = Math.max(states[j].sigma, 1e-5);
      const z = (rets[t] - states[j].mu) / s;
      return p * (Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI)));
    });
    const sum = post.reduce((a, b) => a + b, 0) || 1e-300;
    prev = post.map((p) => p / sum);
    out.push(prev);
  }
  return out;
}

export const MIN_TRAIN_DAYS = 80;

/**
 * 세대마다 다른 시험지 — 훈련 최소 구간 뒤에서 examDays짜리 창의 시작을 무작위로 뽑는다.
 * 직전 세대 창과 minGap일 이상 떨어지도록 몇 번 다시 뽑는다(같은 창의 재채점을 막는다).
 * 순수 함수: rand는 호출자가 준다 (세대 시드로 결정적).
 */
export function pickExamWindow(p: { datesLen: number; examDays: number; rand: () => number; prevStart?: number | null; minTrain?: number; minGap?: number; tries?: number }): { start: number; end: number; choices: number } {
  const minTrain = p.minTrain ?? MIN_TRAIN_DAYS, minGap = p.minGap ?? 30, tries = p.tries ?? 6;
  const last = p.datesLen - 1; // evaluate는 dates[to]까지 필요하므로 창의 끝(exclusive)은 last 이하
  const maxStart = last - p.examDays;
  if (maxStart < minTrain) return { start: Math.max(0, Math.min(minTrain, maxStart)), end: last, choices: 1 };
  const choices = maxStart - minTrain + 1;
  let start = minTrain;
  for (let i = 0; i < tries; i++) {
    start = minTrain + Math.floor(p.rand() * choices);
    if (p.prevStart == null || Math.abs(start - p.prevStart) >= minGap || choices <= minGap) break;
  }
  return { start, end: start + p.examDays, choices };
}

/** 시리즈 → 특징. examDays 만큼을 시험 구간으로 떼어 둔다. trainEndOverride를 주면 그 인덱스 앞까지만 훈련(HMM 적합)한다 */
export function buildFeatures(series: Map<string, BtCandle[]>, examDays = 60, trainEndOverride?: number): FeatureSet {
  const dateSet = new Set<string>();
  for (const cs of series.values()) for (const c of cs) dateSet.add(c.t);
  const dates = [...dateSet].sort();
  const trainEnd = Math.max(MIN_TRAIN_DAYS, Math.min(dates.length - 1, trainEndOverride ?? dates.length - examDays));
  const trainCut = dates[trainEnd - 1];
  const markets: MarketFeatures[] = [];
  for (const [market, cs] of series) {
    if (cs.length < 90) continue;
    const closes = cs.map((c) => c.c);
    const logRets = closes.map((c, i) => (i === 0 ? 0 : Math.log(c / closes[i - 1])));
    const trainRets = cs.filter((c) => c.t <= trainCut).map((_, i) => logRets[i]).slice(1);
    let pBull: number[];
    try {
      const hmm = fitHmm(trainRets.slice(-200), 3);
      const bull = hmm.states.reduce((b, st, i) => (st.mu > hmm.states[b].mu ? i : b), 0);
      // 훈련 구간 파라미터 고정 → 전체 시리즈를 forward filter (시험 구간엔 미래 정보 없음)
      const filt = forwardFilter(logRets.slice(1), hmm.states, hmm.transition, new Array(hmm.k).fill(1 / hmm.k));
      pBull = [0.5, ...filt.map((f) => f[bull])];
    } catch {
      continue; // 적합 실패 마켓은 제외 — 지어내지 않는다
    }
    markets.push({ market, dates: cs.map((c) => c.t), closes, logRets, pBull });
  }
  return { markets, dates, trainEnd };
}

export interface EvalResult {
  dailyRets: number[]; // 시험 구간 일별 수익률 (비용 차감)
  equity: number[]; // 1.0 시작
  totalReturnPct: number;
  sharpe: number; // 연환산
  maxDrawdownPct: number;
  rebalances: number;
  avgExposure: number;
  avgPositions: number;
  lastWeights: Array<{ market: string; weightPct: number }>; // 마지막 리밸런스 타깃 (실전 배치용)
  fitness: number;
}

/** 적합도 = 시험 구간 Sharpe − 2·MDD(비율) − 거래 부족 페널티. 시험지 밖(훈련 구간) 성과는 안 본다 */
export function fitnessOf(r: { sharpe: number; maxDrawdownPct: number; rebalances: number; dailyRets: number[] }): number {
  const mdd = r.maxDrawdownPct / 100;
  const idle = r.rebalances < 2 ? 0.5 : 0;
  return +(r.sharpe - 2 * mdd - idle).toFixed(4);
}

export function evaluate(genes: Genes, f: FeatureSet, window: { from: number; to: number } = { from: f.trainEnd, to: f.dates.length - 1 }): EvalResult {
  const costRate = (DEFAULT_COSTS.feePct + DEFAULT_COSTS.slipPct) / 100;
  const idx = new Map(f.markets.map((m) => [m.market, new Map(m.dates.map((d, i) => [d, i]))]));
  const weights = new Map<string, number>();
  const dailyRets: number[] = [];
  const equity: number[] = [];
  let eq = 1, peak = 1, mdd = 0, rebalances = 0, pendingCost = 0, expSum = 0, posSum = 0, n = 0;
  let lastTargets: Array<{ market: string; weightPct: number }> = [];

  for (let d = window.from; d < window.to; d++) {
    const t = f.dates[d];
    const t1 = f.dates[d + 1];
    if ((d - window.from) % genes.rebalanceDays === 0) {
      // t 종가까지로 점수
      const cands: Array<{ market: string; score: number; vol: number }> = [];
      for (const m of f.markets) {
        const i = idx.get(m.market)!.get(t);
        if (i === undefined || i < Math.max(genes.momWindow, genes.volWindow) + 1) continue;
        if (m.pBull[i] < genes.pBullMin) continue;
        const mom = m.closes[i] / m.closes[i - genes.momWindow] - 1;
        if (mom <= 0) continue;
        const r = m.logRets.slice(i - genes.volWindow + 1, i + 1);
        const mu = r.reduce((a, b) => a + b, 0) / r.length;
        const vol = Math.sqrt(r.reduce((a, x) => a + (x - mu) ** 2, 0) / r.length);
        if (!(vol > 0)) continue;
        cands.push({ market: m.market, score: mom / vol, vol });
      }
      cands.sort((a, b) => b.score - a.score);
      const picks = cands.slice(0, genes.topK);
      const next = new Map<string, number>();
      if (picks.length) {
        const inv = picks.map((p) => 1 / p.vol);
        const sum = inv.reduce((a, b) => a + b, 0);
        let alloc = 0;
        for (const [k, p] of picks.entries()) {
          const w = Math.min(genes.capPct / 100, inv[k] / sum);
          next.set(p.market, w);
          alloc += w;
        }
        // 변동성 목표 → 노출 스케일 (포트폴리오 σ 근사 = Σw·σ)
        const pvol = picks.reduce((a, p) => a + (next.get(p.market) ?? 0) * p.vol * 100, 0);
        const scale = pvol > 0 ? Math.min(genes.exposureMax / Math.max(alloc, 1e-9), (genes.volTargetPct / pvol)) : 1;
        for (const [m, w] of next) next.set(m, Math.min(w, w * Math.min(1, scale)) );
      }
      let turnover = 0;
      for (const m of new Set([...weights.keys(), ...next.keys()])) turnover += Math.abs((next.get(m) ?? 0) - (weights.get(m) ?? 0));
      if (turnover > 1e-9) { pendingCost = turnover * costRate; rebalances++; }
      weights.clear();
      for (const [m, w] of next) weights.set(m, w);
      lastTargets = [...next].map(([market, w]) => ({ market, weightPct: +(w * 100).toFixed(2) }));
    }
    let ret = 0, exp = 0;
    for (const [m, w] of weights) {
      const mi = idx.get(m)!;
      const i0 = mi.get(t), i1 = mi.get(t1);
      const mf = f.markets.find((x) => x.market === m)!;
      if (i0 !== undefined && i1 !== undefined) { ret += w * (mf.closes[i1] / mf.closes[i0] - 1); exp += w; }
    }
    const r = ret - pendingCost;
    pendingCost = 0;
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, (peak - eq) / peak);
    dailyRets.push(r);
    equity.push(+eq.toFixed(5));
    expSum += exp; posSum += weights.size; n++;
  }
  const mu = dailyRets.reduce((a, b) => a + b, 0) / Math.max(1, dailyRets.length);
  const sd = Math.sqrt(dailyRets.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(1, dailyRets.length));
  const sharpe = sd > 0 ? +((mu / sd) * Math.sqrt(365)).toFixed(3) : 0;
  const out = {
    dailyRets, equity,
    totalReturnPct: +((eq - 1) * 100).toFixed(2),
    sharpe,
    maxDrawdownPct: +(mdd * 100).toFixed(2),
    rebalances,
    avgExposure: n ? +(expSum / n).toFixed(3) : 0,
    avgPositions: n ? +(posSum / n).toFixed(2) : 0,
    lastWeights: lastTargets,
  };
  return { ...out, fitness: fitnessOf(out) };
}

/** 하루치 실현 수익 — 최근 타깃 비중을 t→t+1 실제 종가에 적용 (라이브 자본 마킹용) */
export function dayReturn(weights: Array<{ market: string; weightPct: number }>, f: FeatureSet, dayIdx: number): number | null {
  const t = f.dates[dayIdx], t1 = f.dates[dayIdx + 1];
  if (!t || !t1) return null;
  let ret = 0;
  for (const w of weights) {
    const m = f.markets.find((x) => x.market === w.market);
    if (!m) continue;
    const i0 = m.dates.indexOf(t), i1 = m.dates.indexOf(t1);
    if (i0 >= 0 && i1 >= 0) ret += (w.weightPct / 100) * (m.closes[i1] / m.closes[i0] - 1);
  }
  return ret;
}
