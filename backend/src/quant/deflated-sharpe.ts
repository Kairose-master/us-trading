/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014) — 순수 함수.
 *
 * 왜 필요한가: 진화 캠페인은 세대마다 개체 여럿을 채점하고 **최고를 챔피언으로 삼는다**.
 * 시행을 많이 할수록 최고 Sharpe는 실력이 아니라 운으로도 올라간다. DSR은 그 부풀림을
 * (1) 시행 횟수 N, (2) 시행들의 Sharpe 분산, (3) 수익률의 왜도·첨도로 깎아낸 뒤
 * "이 Sharpe가 0보다 크다"의 확률을 준다. 0.95 이상이어야 우연으로 설명되지 않는다.
 *
 * 기대 최대 Sharpe (귀무가설: 모든 시행의 참 Sharpe = 0):
 *   SR₀ = √Var(SR) · [ (1−γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e)) ]
 * 확률적 Sharpe (SR₀을 기준선으로):
 *   DSR = Z[ (SR − SR₀)·√(n−1) / √(1 − skew·SR + ((kurt−1)/4)·SR²) ]
 * SR·skew·kurt는 **같은 주기**(여기서는 일간)여야 한다 — 연환산 Sharpe를 넣으면 안 된다.
 */

const EULER = 0.5772156649015329;

/** 표준정규 CDF — Abramowitz & Stegun 7.1.26 오차함수 근사 (|ε| < 1.5e-7) */
export function normCdf(z: number): number {
  const s = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

/** 표준정규 분위수 — Acklam 근사 (|ε| < 1.15e-9) */
export function normPpf(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface Moments { n: number; mean: number; sd: number; skew: number; kurtosis: number; sharpe: number }
/** 표본 적률 — kurtosis는 **정규분포가 3**인 원시 첨도 (DSR 공식이 그렇게 쓴다) */
export function moments(returns: number[]): Moments {
  const n = returns.length;
  if (n < 2) return { n, mean: 0, sd: 0, skew: 0, kurtosis: 3, sharpe: 0 };
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const m2 = returns.reduce((a, x) => a + (x - mean) ** 2, 0) / n;
  const sd = Math.sqrt(m2);
  if (!(sd > 0)) return { n, mean, sd: 0, skew: 0, kurtosis: 3, sharpe: 0 };
  const m3 = returns.reduce((a, x) => a + (x - mean) ** 3, 0) / n;
  const m4 = returns.reduce((a, x) => a + (x - mean) ** 4, 0) / n;
  return { n, mean, sd, skew: m3 / sd ** 3, kurtosis: m4 / sd ** 4, sharpe: mean / sd };
}

/** 귀무 하에서 N번 시행했을 때 기대되는 최대 Sharpe */
export function expectedMaxSharpe(trials: number, sharpeVariance: number): number {
  const N = Math.max(2, Math.floor(trials));
  const sd = Math.sqrt(Math.max(0, sharpeVariance));
  if (!(sd > 0)) return 0;
  return sd * ((1 - EULER) * normPpf(1 - 1 / N) + EULER * normPpf(1 - 1 / (N * Math.E)));
}

export interface DeflatedSharpe {
  n: number;
  /** 주기(일간) Sharpe */
  sharpe: number;
  /** 연환산 Sharpe (표시용) */
  sharpeAnnual: number;
  skew: number;
  kurtosis: number;
  trials: number;
  /** 시행들의 Sharpe 분산 (주기 단위) */
  sharpeVariance: number;
  /** 귀무 하 기대 최대 Sharpe — 이 선을 넘어야 실력이라 부를 수 있다 */
  sr0: number;
  /** 확률적 Sharpe를 SR₀ 기준으로 — 1에 가까울수록 우연으로 설명되지 않는다 */
  dsr: number;
  /** DSR ≥ 0.95 */
  significant: boolean;
  note: string;
}

/**
 * @param returns 선택된(챔피언) 전략의 주기 수익률
 * @param trials 그 챔피언을 고르기까지 채점한 시행 수
 * @param trialSharpes 시행들의 주기 Sharpe. 분산을 여기서 잰다 (2개 미만이면 0 → DSR은 SR₀=0에서의 PSR)
 * @param periodsPerYear 연환산 표시용 (일봉 365)
 */
export function deflatedSharpe(p: { returns: number[]; trials: number; trialSharpes?: number[]; periodsPerYear?: number }): DeflatedSharpe {
  const ppy = p.periodsPerYear ?? 365;
  const m = moments(p.returns);
  const ts = (p.trialSharpes ?? []).filter((x) => Number.isFinite(x));
  const varSr = ts.length >= 2 ? ts.reduce((a, x) => a + (x - ts.reduce((s, y) => s + y, 0) / ts.length) ** 2, 0) / (ts.length - 1) : 0;
  const trials = Math.max(1, Math.floor(p.trials));
  const sr0 = trials >= 2 ? expectedMaxSharpe(trials, varSr) : 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - m.skew * m.sharpe + ((m.kurtosis - 1) / 4) * m.sharpe ** 2));
  const dsr = m.n >= 2 && m.sd > 0 ? normCdf(((m.sharpe - sr0) * Math.sqrt(m.n - 1)) / denom) : 0;
  const note = varSr === 0 && trials >= 2
    ? `${trials} trials but no spread in their Sharpes was given — SR₀ falls back to 0, so this is a plain probabilistic Sharpe, not deflated`
    : trials < 2
      ? "a single trial — nothing to deflate"
      : `deflated by ${trials} trials (SR₀ ${sr0.toFixed(3)}/period)`;
  return {
    n: m.n,
    sharpe: +m.sharpe.toFixed(5),
    sharpeAnnual: +(m.sharpe * Math.sqrt(ppy)).toFixed(3),
    skew: +m.skew.toFixed(4),
    kurtosis: +m.kurtosis.toFixed(4),
    trials,
    sharpeVariance: +varSr.toFixed(8),
    sr0: +sr0.toFixed(5),
    dsr: +dsr.toFixed(4),
    significant: dsr >= 0.95,
    note,
  };
}
