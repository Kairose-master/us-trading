/**
 * GARCH(1,1) — 수학 지도 ④ (시계열/변동성).
 *   σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
 * 가우시안 로그우도를 파생 없는 좌표 탐색(pattern search)으로 최대화한다 —
 * 우도면이 매끄러워 이 정도로 충분히 수렴하고, 의존성이 없다.
 * 산출: 조건부 σ_t 경로(실계산), 익일 σ 예측, 지속성 α+β.
 */

export interface GarchResult {
  omega: number;
  alpha: number;
  beta: number;
  /** α+β — 1에 가까울수록 변동성 충격이 오래 간다 */
  persistence: number;
  /** 조건부 일간 σ_t 경로 (관측과 같은 길이) */
  condSigma: number[];
  /** 익일 σ 예측 (일간) */
  forecastSigma: number;
  /** 장기(무조건) σ = sqrt(ω/(1-α-β)) */
  longRunSigma: number;
  logLik: number;
  evals: number;
}

function negLogLik(returns: number[], omega: number, alpha: number, beta: number): { nll: number; sigmas: number[] } {
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const eps = returns.map((r) => r - mean);
  const uncondVar = eps.reduce((a, e) => a + e * e, 0) / n;
  let v = uncondVar;
  let nll = 0;
  const sigmas = new Array<number>(n);
  for (let t = 0; t < n; t++) {
    if (t > 0) v = omega + alpha * eps[t - 1] * eps[t - 1] + beta * v;
    v = Math.max(v, 1e-12);
    sigmas[t] = Math.sqrt(v);
    nll += Math.log(v) + (eps[t] * eps[t]) / v;
  }
  return { nll, sigmas };
}

export function fitGarch(returns: number[], maxEvals = 400): GarchResult {
  const n = returns.length;
  if (n < 60) throw new Error(`GARCH 적합에 수익률이 부족합니다 (${n}개)`);
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const uncondVar = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / n;

  // 관례적 초기값에서 좌표 탐색
  let best = { omega: uncondVar * 0.05, alpha: 0.08, beta: 0.88 };
  let bestNll = negLogLik(returns, best.omega, best.alpha, best.beta).nll;
  let evals = 1;
  let step = 0.5;

  const clamp = (p: typeof best) => ({
    omega: Math.max(1e-12, p.omega),
    alpha: Math.min(0.5, Math.max(0, p.alpha)),
    beta: Math.min(0.998, Math.max(0, p.beta)),
  });

  while (evals < maxEvals && step > 1e-4) {
    let improved = false;
    const moves: Array<(p: typeof best, d: 1 | -1) => typeof best> = [
      (p, d) => ({ ...p, omega: p.omega * (d === 1 ? 1 + step : 1 / (1 + step)) }),
      (p, d) => ({ ...p, alpha: p.alpha + d * 0.05 * step }),
      (p, d) => ({ ...p, beta: p.beta + d * 0.05 * step }),
    ];
    for (const move of moves) {
      for (const dir of [1, -1] as const) {
        const cand = clamp(move(best, dir));
        if (cand.alpha + cand.beta >= 0.999) continue;
        const { nll } = negLogLik(returns, cand.omega, cand.alpha, cand.beta);
        evals++;
        if (nll < bestNll - 1e-10) {
          bestNll = nll;
          best = cand;
          improved = true;
        }
      }
    }
    if (!improved) step *= 0.5;
  }

  const { sigmas } = negLogLik(returns, best.omega, best.alpha, best.beta);
  const lastEps = returns[n - 1] - mean;
  const lastVar = sigmas[n - 1] ** 2;
  const forecastVar = best.omega + best.alpha * lastEps * lastEps + best.beta * lastVar;
  const persistence = best.alpha + best.beta;

  return {
    omega: +best.omega.toExponential(4),
    alpha: +best.alpha.toFixed(4),
    beta: +best.beta.toFixed(4),
    persistence: +persistence.toFixed(4),
    condSigma: sigmas.map((s) => +s.toFixed(6)),
    forecastSigma: +Math.sqrt(forecastVar).toFixed(6),
    longRunSigma: persistence < 1 ? +Math.sqrt(best.omega / (1 - persistence)).toFixed(6) : NaN,
    logLik: +(-0.5 * (bestNll + n * Math.log(2 * Math.PI))).toFixed(2),
    evals,
  };
}
