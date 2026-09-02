/**
 * 알파 백테스트 엔진 — 순수 함수 (릴2 "Alpha Research" 뷰의 계산부).
 * 실제 캔들을 넣으면 실제 성과 지표가 나온다. 프론트(lib/crypto/backtest.ts)와
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

export function rsiAt(closes: number[], i: number, period = 14): number {
  if (i < period) return 50;
  let gains = 0;
  let losses = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const d = closes[k] - closes[k - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

function realizedVol(closes: number[], end: number, period: number): number {
  if (end + 1 < period + 1) return NaN;
  const rets: number[] = [];
  for (let i = end - period + 1; i <= end; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
}

// ===== 시그널 라이브러리 (릴2의 Alpha Signal Library에 해당) =====

export const SIGNALS: AlphaSignal[] = [
  {
    id: "vol-spike-reversion",
    name: "거래량 스파이크 평균회귀",
    description:
      "거래량이 20일 평균의 2배를 넘긴 날의 급락은 과잉반응일 확률이 높다 — 스파이크+음봉이면 다음 날부터 3일간 롱, 아니면 현금.",
    code: `spike = v[t] > MA(v,20)*2
if spike and c[t] < o[t]: hold long 3d`,
    position: (candles, i) => {
      // 최근 3일 내 스파이크+음봉이 있었으면 롱
      for (let k = Math.max(0, i - 2); k <= i; k++) {
        if (k < 20) continue;
        const vAvg = ma(candles.map((c) => c.v), k, 20);
        if (!Number.isNaN(vAvg) && candles[k].v > vAvg * 2 && candles[k].c < candles[k].o) return 1;
      }
      return 0;
    },
  },
  {
    id: "rsi-reversion",
    name: "RSI 평균회귀",
    description: "RSI(14) 30 하향 이탈 시 진입, 55 회복 시 청산. 과매도 반등을 먹는 고전 전략.",
    code: `if RSI14 < 30: enter
if RSI14 > 55: exit`,
    position: (() => {
      // 상태(보유 여부)가 필요한 시그널 — 클로저 없이 매 호출 재계산 (순수성 유지)
      return (candles: BtCandle[], i: number): 0 | 1 => {
        const closes = candles.map((c) => c.c);
        let held: 0 | 1 = 0;
        for (let k = 14; k <= i; k++) {
          const r = rsiAt(closes, k);
          if (held === 0 && r < 30) held = 1;
          else if (held === 1 && r > 55) held = 0;
        }
        return held;
      };
    })(),
  },
  {
    id: "momentum-20",
    name: "20일 모멘텀 추세추종",
    description: "종가가 20일 이동평균 위면 롱, 아래면 현금. 추세장에서 벌고 횡보장에서 잃는 만큼만 잃는다.",
    code: `if c[t] > MA(c,20): long else cash`,
    position: (candles, i) => {
      const m = ma(candles.map((c) => c.c), i, 20);
      return !Number.isNaN(m) && candles[i].c > m ? 1 : 0;
    },
  },
  {
    id: "vol-regime",
    name: "변동성 레짐 필터",
    description: "단기(10일) 실현변동성이 장기(60일)보다 낮은 안정 레짐에서만 롱. 급변동 구간을 피한다.",
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

export interface BacktestResult {
  signalId: string;
  market: string;
  days: number;
  /** 전략 에쿼티 (1.0 시작) */
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
  };
  monthlyReturns: Array<{ month: string; strategyPct: number; benchmarkPct: number }>;
}

export function runBacktest(candles: BtCandle[], signal: AlphaSignal, market: string): BacktestResult {
  const n = candles.length;
  let eq = 1;
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
    prevPos = pos;
    const ret = candles[i + 1].c / candles[i].c - 1;
    const stratRet = pos === 1 ? ret : 0;
    eq *= 1 + stratRet;
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
    equity,
    metrics: {
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
