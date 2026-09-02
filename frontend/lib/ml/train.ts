import type { Dataset, FeatureVector } from "@/lib/ml/features";

/**
 * 로지스틱 회귀 학습 — 미니배치 SGD, 의존성 zero, 전부 실계산.
 * loss 히스토리·스텝 카운터는 실제 학습 과정의 실측값이다 (릴3의
 * 라이브 loss 곡선/카운터에 대응). 프론트 lib/ml/train.ts와 동일 로직 —
 * 시드 고정 셔플이라 같은 데이터+같은 하이퍼파라미터면 같은 결과가 나온다.
 */

export interface TrainParams {
  learningRate: number; // 예: 0.05
  epochs: number;       // 예: 60
  l2: number;           // 예: 0.001
  batchSize: number;    // 예: 16
  seed: number;         // 셔플 시드 (재현성)
}

export const DEFAULT_PARAMS: TrainParams = { learningRate: 0.05, epochs: 60, l2: 0.001, batchSize: 16, seed: 42 };

export interface EpochLog {
  epoch: number;
  loss: number;     // 평균 log loss
  accuracy: number; // train 정확도
}

export interface TrainedModel {
  weights: number[];
  epochs: EpochLog[];
  steps: number;       // 총 파라미터 업데이트 횟수 (실측)
  finalLoss: number;
  finalAccuracy: number;
  samples: number;
  params: TrainParams;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function predictProb(weights: number[], x: FeatureVector): number {
  let z = 0;
  for (let j = 0; j < weights.length; j++) z += weights[j] * x[j];
  return sigmoid(z);
}

/** mulberry32 — 시드 고정 PRNG (재현 가능한 셔플) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function meanLoss(weights: number[], X: FeatureVector[], y: number[]): { loss: number; acc: number } {
  let loss = 0;
  let correct = 0;
  const eps = 1e-9;
  for (let i = 0; i < X.length; i++) {
    const p = predictProb(weights, X[i]);
    loss += -(y[i] * Math.log(p + eps) + (1 - y[i]) * Math.log(1 - p + eps));
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
  }
  return { loss: loss / Math.max(1, X.length), acc: correct / Math.max(1, X.length) };
}

/** onEpoch 콜백으로 라이브 로그 스트림(콘솔 뷰)에 공급할 수 있다 */
export function trainLogistic(data: Dataset, params: TrainParams, onEpoch?: (log: EpochLog) => void): TrainedModel {
  const { X, y } = data;
  const dim = X[0]?.length ?? 0;
  const weights = new Array<number>(dim).fill(0);
  const random = rng(params.seed);
  const order = X.map((_, i) => i);
  const epochs: EpochLog[] = [];
  let steps = 0;

  for (let e = 0; e < params.epochs; e++) {
    // Fisher-Yates (시드 고정)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let b = 0; b < order.length; b += params.batchSize) {
      const batch = order.slice(b, b + params.batchSize);
      const grad = new Array<number>(dim).fill(0);
      for (const idx of batch) {
        const p = predictProb(weights, X[idx]);
        const err = p - y[idx];
        for (let j = 0; j < dim; j++) grad[j] += err * X[idx][j];
      }
      for (let j = 0; j < dim; j++) {
        // bias(j=0)에는 L2를 걸지 않는다
        const reg = j === 0 ? 0 : params.l2 * weights[j];
        weights[j] -= params.learningRate * (grad[j] / batch.length + reg);
      }
      steps++;
    }
    const { loss, acc } = meanLoss(weights, X, y);
    const log: EpochLog = { epoch: e + 1, loss: +loss.toFixed(5), accuracy: +acc.toFixed(4) };
    epochs.push(log);
    onEpoch?.(log);
  }

  const last = epochs[epochs.length - 1] ?? { loss: NaN, accuracy: NaN, epoch: 0 };
  return {
    weights: weights.map((w) => +w.toFixed(5)),
    epochs,
    steps,
    finalLoss: last.loss,
    finalAccuracy: last.accuracy,
    samples: X.length,
    params,
  };
}
