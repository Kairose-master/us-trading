/**
 * 가우시안 HMM 레짐 필터 — 수학 지도 ①⑤⑦ (HMM → Bayesian filtering → regime switching).
 * 관측 Y_t = 일간 로그수익률, 은닉 Z_t ∈ {1..K}. Baum-Welch EM으로
 * (초기분포, 전이행렬 A, 상태별 μ/σ)를 적합하고, 포워드 필터로
 * π_t(i) = P(Z_t=i | Y_{1:t}) 를 계산한다 — 스무딩이 아니라 필터값을 내보내는
 * 이유: 실시간 에이전트가 t 시점에 실제로 알 수 있는 believe state가 이것이라서.
 * 의존성 zero, 스케일드 forward-backward로 언더플로 방지. 프론트와 동일 로직.
 */

export interface HmmState {
  mu: number;      // 일간 평균수익
  sigma: number;   // 일간 변동성
  label: string;   // 모멘트에서 유도한 이름 (사후 라벨링 — 학습에는 안 쓰임)
}

export interface HmmResult {
  k: number;
  states: HmmState[];
  /** A[i][j] = P(Z_{t+1}=j | Z_t=i) */
  transition: number[][];
  /** filtered[t][i] = P(Z_t=i | Y_{1:t}) */
  filtered: number[][];
  /** 마지막 시점 belief */
  current: number[];
  /** 1스텝 예측 P(Z_{t+1}=i | Y_{1:t}) = currentᵀA */
  predicted: number[];
  logLik: number;
  emIters: number;
}

const SIGMA_FLOOR = 1e-5;

function gauss(y: number, mu: number, sigma: number): number {
  const s = Math.max(sigma, SIGMA_FLOOR);
  const z = (y - mu) / s;
  return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
}

function labelStates(states: Array<{ mu: number; sigma: number }>): HmmState[] {
  // 사후 라벨: σ 최댓값 상태는 고변동, 나머지는 μ 부호로 강세/약세
  const maxSigma = Math.max(...states.map((s) => s.sigma));
  return states.map((s) => ({
    ...s,
    label: s.sigma === maxSigma && states.length > 2 ? "고변동" : s.mu >= 0 ? "강세" : "약세",
  }));
}

export function fitHmm(returns: number[], k = 3, maxIters = 80): HmmResult {
  const n = returns.length;
  if (n < 60) throw new Error(`HMM 적합에 수익률이 부족합니다 (${n}개)`);

  // 초기화: 전체 σ 기준 배율 + 분위수 평균 (결정적 — 시드 불필요)
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / n);
  const mus = k === 2 ? [mean + 0.3 * sd, mean - 0.3 * sd] : [mean + 0.3 * sd, mean - 0.3 * sd, mean];
  const sigmas = k === 2 ? [0.7 * sd, 1.3 * sd] : [0.7 * sd, 1.0 * sd, 2.0 * sd];
  let states = mus.map((mu, i) => ({ mu, sigma: Math.max(sigmas[i], SIGMA_FLOOR) }));
  let A = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 0.9 : 0.1 / (k - 1))),
  );
  let pi0 = new Array<number>(k).fill(1 / k);

  let logLik = -Infinity;
  let iters = 0;

  const alpha: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(0));
  const beta: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(0));
  const scale = new Array<number>(n).fill(0);

  for (let it = 0; it < maxIters; it++) {
    iters = it + 1;
    const B = returns.map((y) => states.map((s) => Math.max(gauss(y, s.mu, s.sigma), 1e-300)));

    // forward (스케일드)
    let c = 0;
    for (let i = 0; i < k; i++) {
      alpha[0][i] = pi0[i] * B[0][i];
      c += alpha[0][i];
    }
    scale[0] = c;
    for (let i = 0; i < k; i++) alpha[0][i] /= c;
    for (let t = 1; t < n; t++) {
      c = 0;
      for (let j = 0; j < k; j++) {
        let s = 0;
        for (let i = 0; i < k; i++) s += alpha[t - 1][i] * A[i][j];
        alpha[t][j] = s * B[t][j];
        c += alpha[t][j];
      }
      scale[t] = c;
      for (let j = 0; j < k; j++) alpha[t][j] /= c;
    }
    const ll = scale.reduce((a, s) => a + Math.log(s), 0);

    // backward (스케일드)
    for (let i = 0; i < k; i++) beta[n - 1][i] = 1;
    for (let t = n - 2; t >= 0; t--) {
      for (let i = 0; i < k; i++) {
        let s = 0;
        for (let j = 0; j < k; j++) s += A[i][j] * B[t + 1][j] * beta[t + 1][j];
        beta[t][i] = s / scale[t + 1];
      }
    }

    // E: γ, ξ  /  M: 파라미터 갱신
    const gammaSum = new Array<number>(k).fill(0);
    const muNum = new Array<number>(k).fill(0);
    const xiNum = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const gammaSumNoLast = new Array<number>(k).fill(0);
    const gamma: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(0));
    for (let t = 0; t < n; t++) {
      let norm = 0;
      for (let i = 0; i < k; i++) {
        gamma[t][i] = alpha[t][i] * beta[t][i];
        norm += gamma[t][i];
      }
      for (let i = 0; i < k; i++) {
        gamma[t][i] /= norm;
        gammaSum[i] += gamma[t][i];
        muNum[i] += gamma[t][i] * returns[t];
        if (t < n - 1) gammaSumNoLast[i] += gamma[t][i];
      }
    }
    for (let t = 0; t < n - 1; t++) {
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          xiNum[i][j] += (alpha[t][i] * A[i][j] * B[t + 1][j] * beta[t + 1][j]) / scale[t + 1];
        }
      }
    }
    pi0 = gamma[0].slice();
    A = xiNum.map((row, i) => row.map((v) => v / Math.max(gammaSumNoLast[i], 1e-12)));
    const newStates = states.map((_, i) => {
      const mu = muNum[i] / Math.max(gammaSum[i], 1e-12);
      let varr = 0;
      for (let t = 0; t < n; t++) varr += gamma[t][i] * (returns[t] - mu) ** 2;
      return { mu, sigma: Math.max(Math.sqrt(varr / Math.max(gammaSum[i], 1e-12)), SIGMA_FLOOR) };
    });
    states = newStates;

    if (Math.abs(ll - logLik) < 1e-7 * Math.abs(ll)) {
      logLik = ll;
      break;
    }
    logLik = ll;
  }

  // 최종 파라미터로 필터드 posteriors (예측→관측→갱신)
  const filtered: number[][] = [];
  let belief = pi0.slice();
  for (let t = 0; t < n; t++) {
    const pred = new Array<number>(k).fill(0);
    if (t === 0) {
      for (let i = 0; i < k; i++) pred[i] = pi0[i];
    } else {
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) pred[j] += belief[i] * A[i][j];
    }
    let norm = 0;
    const upd = pred.map((p, i) => {
      const v = p * Math.max(gauss(returns[t], states[i].mu, states[i].sigma), 1e-300);
      norm += v;
      return v;
    });
    belief = upd.map((v) => v / norm);
    filtered.push(belief.map((v) => +v.toFixed(5)));
  }
  const predicted = new Array<number>(k).fill(0);
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) predicted[j] += belief[i] * A[i][j];

  return {
    k,
    states: labelStates(states),
    transition: A.map((row) => row.map((v) => +v.toFixed(4))),
    filtered,
    current: belief.map((v) => +v.toFixed(4)),
    predicted: predicted.map((v) => +v.toFixed(4)),
    logLik: +logLik.toFixed(2),
    emIters: iters,
  };
}
