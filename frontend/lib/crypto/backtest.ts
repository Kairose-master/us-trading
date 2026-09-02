import { fitHmm } from "@/lib/quant/regime"

/**
 * 알파 백테스트 엔진 — 순수 함수 (릴2 "Alpha Research" 뷰의 계산부).
 * RSI 같은 장난감 지표는 쓰지 않는다 — 시그널은 레짐 belief(HMM), 모멘텀
 * 팩터, 변동성 군집 세 가지뿐이다.
 * 실제 캔들을 넣으면 실제 성과 지표가 나온다. 백엔드(crypto/backtest.ts)와
 * 동일 로직 — 한쪽을 고치면 다른 쪽도 맞출 것.
 *
 * 규약: 시그널은 t 종가까지의 정보로 t+1 수익률에 대한 목표 포지션(0 또는 1)을
 * 정한다 — 룩어헤드 없음. 현물 기준이라 공매도 없음(0/1).
 */

export interface BtCandle {
  t: string; // ISO 날짜
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AlphaSignal {
  id: string;
  name: string;
  description: string;
  /** 인스펙터에 보여줄 코드 (실제 구현 요약) */
  code: string;
  /** candles[0..i]까지 보고 t+1 목표 포지션 반환 (0 | 1) */
  position: (candles: BtCandle[], i: number) => 0 | 1;
}

// ===== 지표 =====

function ma(values: number[], end: number, period: number): number {
  if (end + 1 < period) return NaN;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) s += values[i];
  return s / period;
}

function realizedVol(closes: number[], end: number, period: number): number {
  if (end + 1 < period + 1) return NaN;
  const rets: number[] = [];
  for (let i = end - period + 1; i <= end; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
}

// ===== 시그널 라이브러리 (릴2의 Alpha Signal Library에 해당) =====

/**
 * HMM 레짐 시그널의 캐시 — 같은 캔들 배열에 대해 한 번만 적합한다.
 * 규약: 파라미터는 앞 FIT_WINDOW 개 수익률로만 적합(EM), 그 뒤는 포워드 필터로
 * P(Z_t | Y_1:t)만 갱신한다 — t 시점에 실제로 알 수 있는 belief. 적합 구간
 * 안쪽(i < FIT_WINDOW)은 파라미터가 미래를 본 셈이라 포지션 0으로 둔다.
 */
const HMM_FIT_WINDOW = 120;
const hmmCache = new WeakMap<BtCandle[], { pBull: number[] }>();

function hmmBullProb(candles: BtCandle[]): number[] {
  const hit = hmmCache.get(candles);
  if (hit) return hit.pBull;
  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) rets.push(Math.log(candles[i].c / candles[i - 1].c));
  const pBull = new Array<number>(candles.length).fill(0);
  if (rets.length >= HMM_FIT_WINDOW) {
    const fit = fitHmm(rets.slice(0, HMM_FIT_WINDOW), 3);
    const bull = fit.states.reduce((b, st, i) => (st.mu > fit.states[b].mu ? i : b), 0);
    // 적합 구간 끝의 belief에서 출발해 앞으로 필터
    let belief = fit.filtered[fit.filtered.length - 1].slice();
    const k = fit.k;
    const gauss = (y: number, mu: number, sigma: number) => {
      const sd = Math.max(sigma, 1e-5);
      const z = (y - mu) / sd;
      return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
    };
    for (let t = HMM_FIT_WINDOW; t < rets.length; t++) {
      const pred = new Array<number>(k).fill(0);
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) pred[j] += belief[i] * fit.transition[i][j];
      let norm = 0;
      const upd = pred.map((pp, i) => {
        const v = pp * Math.max(gauss(rets[t], fit.states[i].mu, fit.states[i].sigma), 1e-300);
        norm += v;
        return v;
      });
      belief = upd.map((v) => v / norm);
      pBull[t + 1] = belief[bull]; // rets[t]는 candles[t+1] 종가까지의 정보
    }
  }
  hmmCache.set(candles, { pBull });
  return pBull;
}

export const SIGNALS: AlphaSignal[] = [
  {
    id: "hmm-regime",
    name: "HMM 레짐 필터",
    description:
      "3상태 가우시안 HMM을 앞 120일로 적합하고, 그 뒤는 포워드 필터로 P(강세 레짐 | 지금까지의 수익률)를 갱신한다. 그 확률이 0.5를 넘을 때만 롱. 지표가 아니라 belief state다.",
    code: `fit HMM(k=3) on first 120d
π_t = filter(π_{t-1}, r_t)   # P(Z_t | Y_1:t)
if π_t[bull] > 0.5: long else cash`,
    position: (candles, i) => (hmmBullProb(candles)[i] > 0.5 ? 1 : 0),
  },
  {
    id: "momentum-20",
    name: "20일 모멘텀 팩터",
    description: "종가가 20일 이동평균 위면 롱, 아래면 현금. 학술적으로 문서화된 시계열 모멘텀 팩터의 가장 단순한 형태 — 추세장에서 벌고 횡보장에서 비용만큼 잃는다.",
    code: `if c[t] > MA(c,20): long else cash`,
    position: (candles, i) => {
      const m = ma(candles.map((c) => c.c), i, 20);
      return !Number.isNaN(m) && candles[i].c > m ? 1 : 0;
    },
  },
  {
    id: "vol-regime",
    name: "변동성 레짐 필터",
    description: "단기(10일) 실현변동성이 장기(60일)보다 낮은 안정 레짐에서만 롱. 변동성 군집(GARCH가 모델링하는 그것)을 가장 단순하게 쓰는 필터.",
    code: `if RV(10) < RV(60)*0.9: long else cash`,
    position: (candles, i) => {
      const closes = candles.map((c) => c.c);
      const short = realizedVol(closes, i, 10);
      const long = realizedVol(closes, i, 60);
      return !Number.isNaN(short) && !Number.isNaN(long) && short < long * 0.9 ? 1 : 0;
    },
  },
];

// ===== 백테스트 =====

export interface TradingCosts {
  /** 편도 수수료 % (업비트 현물 0.05) */
  feePct: number;
  /** 편도 슬리피지 가정 % (시장가, 유동 마켓 보수 가정) */
  slipPct: number;
}

/** 기본 비용 — 왕복 0.2%. 비용 없는 백테스트 숫자는 상한선일 뿐이다. */
export const DEFAULT_COSTS: TradingCosts = { feePct: 0.05, slipPct: 0.05 };

export interface BacktestResult {
  signalId: string;
  market: string;
  days: number;
  costs: TradingCosts;
  /** 전략 에쿼티 (1.0 시작, 비용 차감 후) */
  equity: Array<{ t: string; strategy: number; benchmark: number }>;
  metrics: {
    totalReturnPct: number;
    annualReturnPct: number;
    benchmarkReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    winRatePct: number; // 포지션 보유일 중 양(+)수익일 비율
    trades: number; // 진입 횟수
    exposurePct: number; // 포지션 보유일 비율
    /** 비용이 갉아먹은 총수익 %p (무비용 총수익 − 비용반영 총수익) */
    costDragPct: number;
  };
  monthlyReturns: Array<{ month: string; strategyPct: number; benchmarkPct: number }>;
}

export function runBacktest(
  candles: BtCandle[],
  signal: AlphaSignal,
  market: string,
  costs: TradingCosts = DEFAULT_COSTS,
): BacktestResult {
  const n = candles.length;
  const costRate = (costs.feePct + costs.slipPct) / 100; // 편도
  let eq = 1;
  let eqGross = 1; // 무비용 (드래그 계산용)
  let bench = 1;
  let peak = 1;
  let maxDd = 0;
  let wins = 0;
  let heldDays = 0;
  let trades = 0;
  let prevPos: 0 | 1 = 0;
  const dailyRets: number[] = [];
  const equity: BacktestResult["equity"] = [{ t: candles[0].t, strategy: 1, benchmark: 1 }];
  const monthly = new Map<string, { s: number; b: number }>();

  for (let i = 0; i < n - 1; i++) {
    const pos = signal.position(candles, i);
    if (pos === 1 && prevPos === 0) trades++;
    const turnover = Math.abs(pos - prevPos); // 진입/청산 시 1
    prevPos = pos;
    const ret = candles[i + 1].c / candles[i].c - 1;
    const grossRet = pos === 1 ? ret : 0;
    const stratRet = grossRet - turnover * costRate;
    eq *= 1 + stratRet;
    eqGross *= 1 + grossRet;
    bench *= 1 + ret;
    dailyRets.push(stratRet);
    if (pos === 1) {
      heldDays++;
      if (stratRet > 0) wins++;
    }
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
    const t = candles[i + 1].t;
    equity.push({ t, strategy: +eq.toFixed(4), benchmark: +bench.toFixed(4) });

    const month = t.slice(0, 7);
    const m = monthly.get(month) ?? { s: 1, b: 1 };
    m.s *= 1 + stratRet;
    m.b *= 1 + ret;
    monthly.set(month, m);
  }
  // 종료 시점 보유분 청산 비용 — 열린 포지션의 비용을 숨기지 않는다
  if (prevPos === 1) {
    eq *= 1 - costRate;
    equity[equity.length - 1].strategy = +eq.toFixed(4);
  }

  const years = (n - 1) / 365;
  const mean = dailyRets.reduce((a, b) => a + b, 0) / Math.max(1, dailyRets.length);
  const sd = Math.sqrt(
    dailyRets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, dailyRets.length),
  );
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;

  return {
    signalId: signal.id,
    market,
    days: n,
    costs,
    equity,
    metrics: {
      costDragPct: +((eqGross - eq) * 100).toFixed(2),
      totalReturnPct: +((eq - 1) * 100).toFixed(2),
      annualReturnPct: years > 0 ? +((Math.pow(eq, 1 / years) - 1) * 100).toFixed(2) : 0,
      benchmarkReturnPct: +((bench - 1) * 100).toFixed(2),
      sharpe: +sharpe.toFixed(2),
      maxDrawdownPct: +(-maxDd * 100).toFixed(2),
      winRatePct: heldDays > 0 ? +((wins / heldDays) * 100).toFixed(1) : 0,
      trades,
      exposurePct: +((heldDays / Math.max(1, n - 1)) * 100).toFixed(1),
    },
    monthlyReturns: [...monthly.entries()].map(([month, m]) => ({
      month,
      strategyPct: +((m.s - 1) * 100).toFixed(2),
      benchmarkPct: +((m.b - 1) * 100).toFixed(2),
    })),
  };
}
