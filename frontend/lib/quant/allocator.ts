/**
 * 온라인 전문가 배분 — 수학 지도 ⑰ (online learning / exponential weights).
 *   w_{i,t+1} ∝ w_{i,t} · e^{η·r_{i,t}}
 * "어떤 전략을 믿을 것인가" 자체를 학습하는 층. 룩어헤드 없음:
 * t일 수익에는 t일 시작 시점의 가중치(그 전날까지의 정보)만 쓰인다.
 */

export interface ExpertSeries {
  id: string;
  name: string;
  /** 일간 수익률 (모두 같은 길이·같은 날짜축) */
  returns: number[];
}

export interface AllocatorResult {
  eta: number;
  experts: Array<{ id: string; name: string; finalWeight: number; annualPct: number; sharpe: number }>;
  /** weightPath[t][i] — t일 시작 시점 가중치 */
  weightPath: number[][];
  /** 배분 포트폴리오의 일간 수익률 */
  blended: number[];
  blendedAnnualPct: number;
  blendedSharpe: number;
}

function annPct(returns: number[]): number {
  const eq = returns.reduce((a, r) => a * (1 + r), 1);
  const years = returns.length / 365;
  return years > 0 ? +((Math.pow(eq, 1 / years) - 1) * 100).toFixed(2) : 0;
}

function sharpe(returns: number[]): number {
  const n = returns.length;
  const mu = returns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mu) ** 2, 0) / n);
  return sd > 0 ? +((mu / sd) * Math.sqrt(365)).toFixed(2) : 0;
}

export function exponentialWeights(experts: ExpertSeries[], eta = 10): AllocatorResult {
  const m = experts.length;
  const n = Math.min(...experts.map((e) => e.returns.length));
  let w = new Array<number>(m).fill(1 / m);
  const weightPath: number[][] = [];
  const blended: number[] = [];

  for (let t = 0; t < n; t++) {
    weightPath.push(w.map((v) => +v.toFixed(4)));
    // t일 수익은 t일 시작 가중치로 (predict → observe → update)
    let r = 0;
    for (let i = 0; i < m; i++) r += w[i] * experts[i].returns[t];
    blended.push(r);
    // 갱신
    const next = w.map((v, i) => v * Math.exp(eta * experts[i].returns[t]));
    const norm = next.reduce((a, b) => a + b, 0);
    w = next.map((v) => v / norm);
  }

  return {
    eta,
    experts: experts.map((e, i) => ({
      id: e.id,
      name: e.name,
      finalWeight: +w[i].toFixed(4),
      annualPct: annPct(e.returns.slice(0, n)),
      sharpe: sharpe(e.returns.slice(0, n)),
    })),
    weightPath,
    blended,
    blendedAnnualPct: annPct(blended),
    blendedSharpe: sharpe(blended),
  };
}
