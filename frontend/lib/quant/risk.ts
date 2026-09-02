/**
 * 리스크 수학 — 수학 지도 ⑫ (VaR/ES/드로다운) + ⑪ Kelly.
 * 전부 수익률 시계열에 대한 순수 함수. "좋은 예측기보다 잘못됐을 때
 * 얼마나 잃는지 제한하는 구조가 더 중요할 때가 많다"의 계산부.
 */

export interface RiskMetrics {
  /** 역사적 VaR (일간, 손실을 양수로) */
  var95Pct: number;
  var99Pct: number;
  /** Expected Shortfall — VaR 초과 손실의 평균 */
  es95Pct: number;
  /** 최대 드로다운 (음수 %) */
  maxDrawdownPct: number;
  /** 하방 편차 (연환산 %) — 손실일만의 변동성 */
  downsideDevPct: number;
  /** 연환산 변동성 % */
  annVolPct: number;
}

export function riskMetrics(returns: number[]): RiskMetrics {
  const n = returns.length;
  const sorted = [...returns].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.max(0, Math.min(n - 1, Math.floor(n * p)))];
  const var95 = -q(0.05);
  const var99 = -q(0.01);
  const tail95 = sorted.slice(0, Math.max(1, Math.floor(n * 0.05)));
  const es95 = -tail95.reduce((a, b) => a + b, 0) / tail95.length;

  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of returns) {
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / n);
  const downs = returns.filter((r) => r < 0);
  const downDev = downs.length > 0 ? Math.sqrt(downs.reduce((a, r) => a + r * r, 0) / n) : 0;

  return {
    var95Pct: +(var95 * 100).toFixed(2),
    var99Pct: +(var99 * 100).toFixed(2),
    es95Pct: +(es95 * 100).toFixed(2),
    maxDrawdownPct: +(-maxDd * 100).toFixed(2),
    downsideDevPct: +(downDev * Math.sqrt(365) * 100).toFixed(2),
    annVolPct: +(sd * Math.sqrt(365) * 100).toFixed(2),
  };
}

export interface KellyResult {
  /** 풀 Kelly f* = μ/σ² (0~1 클램프) */
  fullKelly: number;
  /** 하프 Kelly — 추정오차 방어 관례 */
  halfKelly: number;
  /** μ̂, σ̂ (일간) */
  muDaily: number;
  sigmaDaily: number;
}

/** log-utility 근사 f* ≈ μ/σ² — 신호가 맞느냐와 얼마를 거느냐의 분리 */
export function kellyFraction(returns: number[]): KellyResult {
  const n = returns.length;
  const mu = returns.reduce((a, b) => a + b, 0) / n;
  const varr = returns.reduce((a, r) => a + (r - mu) ** 2, 0) / n;
  const full = varr > 0 ? Math.min(1, Math.max(0, mu / varr)) : 0;
  return {
    fullKelly: +full.toFixed(3),
    halfKelly: +(full / 2).toFixed(3),
    muDaily: +mu.toFixed(6),
    sigmaDaily: +Math.sqrt(varr).toFixed(6),
  };
}
