import { rng } from "@/lib/ml/train";

/**
 * 백테스트 통계 — 수학 지도 ㉑ (별표 세 개짜리).
 * "수백 개 전략을 테스트하면 우연히 Sharpe 높은 게 반드시 나온다"의 계산부:
 *  - Sharpe 표준오차 (Lo 2002 근사)
 *  - 무빙블록 부트스트랩 p-값 — 자기상관 있는 금융 시계열에서 iid 재표집은
 *    금물이므로 블록째로 재표집한다
 *  - 다중검정: 테스트한 전략 수 N에 대한 Bonferroni 보정 임계
 */

export interface BacktestStats {
  n: number;
  sharpeAnnual: number;
  /** Sharpe 표준오차 (연환산) */
  sharpeSe: number;
  /** 95% 신뢰구간 */
  sharpeCi95: [number, number];
  /** H0: 평균수익 ≤ 0 에 대한 블록 부트스트랩 p-값 */
  bootstrapP: number;
  bootstrapIters: number;
  blockLen: number;
  /** 테스트한 전략 수 */
  strategiesTested: number;
  /** Bonferroni 보정 유의수준 (0.05/N) */
  bonferroniAlpha: number;
  /** p < 보정 임계 인가 — 다중검정을 견디는가 */
  survivesMultipleTesting: boolean;
}

export function backtestStats(
  returns: number[],
  strategiesTested: number,
  opts: { iters?: number; blockLen?: number; seed?: number } = {},
): BacktestStats {
  const n = returns.length;
  const iters = opts.iters ?? 2000;
  const blockLen = opts.blockLen ?? 20;
  const random = rng(opts.seed ?? 11);

  const mu = returns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mu) ** 2, 0) / n);
  const srDaily = sd > 0 ? mu / sd : 0;
  const srAnnual = srDaily * Math.sqrt(365);
  // Lo(2002) iid 근사: SE(SR_daily) ≈ sqrt((1 + SR²/2)/n)
  const seAnnual = Math.sqrt((1 + (srDaily * srDaily) / 2) / n) * Math.sqrt(365);

  // 무빙블록 부트스트랩: 평균수익의 귀무분포(중심화) 대비 관측 평균의 위치
  let geq = 0;
  const centered = returns.map((r) => r - mu);
  for (let b = 0; b < iters; b++) {
    let sum = 0;
    let count = 0;
    while (count < n) {
      const start = Math.floor(random() * (n - blockLen));
      for (let j = 0; j < blockLen && count < n; j++, count++) sum += centered[start + j];
    }
    if (sum / n >= mu) geq++;
  }
  const p = (geq + 1) / (iters + 1);

  const bonferroni = 0.05 / Math.max(1, strategiesTested);
  return {
    n,
    sharpeAnnual: +srAnnual.toFixed(2),
    sharpeSe: +seAnnual.toFixed(2),
    sharpeCi95: [+(srAnnual - 1.96 * seAnnual).toFixed(2), +(srAnnual + 1.96 * seAnnual).toFixed(2)],
    bootstrapP: +p.toFixed(4),
    bootstrapIters: iters,
    blockLen,
    strategiesTested,
    bonferroniAlpha: +bonferroni.toFixed(4),
    survivesMultipleTesting: p < bonferroni,
  };
}
