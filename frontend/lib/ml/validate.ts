import type { CryptoCandle as BtCandle } from "@/lib/crypto/upbit";
import type { AlphaSignal } from "@/lib/crypto/backtest";
import { runBacktest, type BacktestResult } from "@/lib/crypto/backtest";
import { buildDataset, featuresAt } from "@/lib/ml/features";
import { trainLogistic, predictProb, type TrainParams, type TrainedModel } from "@/lib/ml/train";

/**
 * Walk-forward 검증 — 학습창에서만 학습한 모델을 그 뒤 구간(out-of-sample)에서
 * 백테스트한다. in-sample 성과는 항상 좋아 보이므로, 신뢰할 수 있는 숫자는
 * OOS 쪽뿐이라는 사실을 표면에 그대로 드러낸다. 프론트와 동일 로직.
 */

export interface ValidationReport {
  market: string;
  trainRange: { from: string; to: string; samples: number };
  testRange: { from: string; to: string; days: number };
  model: TrainedModel;
  /** 학습셋 예측확률의 quantile 분위수로 정한 실제 임계값 */
  threshold: number;
  /** 임계 분위수 (예: 0.6 = 상위 40% 확신일에만 롱) */
  quantile: number;
  inSample: BacktestResult["metrics"];
  outOfSample: BacktestResult["metrics"];
  oosEquity: BacktestResult["equity"];
}

/** 학습된 모델을 기존 백테스트 체계의 AlphaSignal("alpha operator")로 감싼다 */
export function modelAsSignal(model: TrainedModel, threshold: number): AlphaSignal {
  return {
    id: "ml-alpha",
    name: "ML 알파 (로지스틱)",
    description: `학습된 로지스틱 회귀 — P(상승) > ${threshold}일 때 롱. 피처 8종, 학습 스텝 ${model.steps}회.`,
    code: `p = sigmoid(w · features[t])
if p > ${threshold}: long else cash`,
    position: (candles, i) => {
      const f = featuresAt(candles, i);
      if (!f) return 0;
      return predictProb(model.weights, f) > threshold ? 1 : 0;
    },
  };
}

export function walkForwardValidate(
  candles: BtCandle[],
  market: string,
  params: TrainParams,
  quantile = 0.6,
  trainFraction = 0.7,
  onEpoch?: Parameters<typeof trainLogistic>[2],
): ValidationReport {
  const split = Math.floor(candles.length * trainFraction);
  const trainData = buildDataset(candles, 0, split);
  if (trainData.X.length < 60) throw new Error(`학습 샘플 부족 (${trainData.X.length}개) — 캔들을 늘리세요`);

  const model = trainLogistic(trainData, params, onEpoch);

  // 임계값을 고정하지 않고 학습셋 예측확률의 분위수로 잡는다 — 약하게 보정된
  // 모델(출력이 0.5 근처에 몰림)에서도 "상위 (1-q) 확신일에만 롱"이 성립한다.
  const probs = trainData.X.map((x) => predictProb(model.weights, x)).sort((a, b) => a - b);
  const qi = Math.min(probs.length - 1, Math.max(0, Math.floor(probs.length * quantile)));
  const threshold = +probs[qi].toFixed(5);
  const signal = modelAsSignal(model, threshold);

  // in-sample: 학습창 백테스트 / OOS: 학습창 이후만 (워밍업 60일 겹침 포함해 슬라이스)
  const inSampleBt = runBacktest(candles.slice(0, split), signal, market);
  const oosSlice = candles.slice(Math.max(0, split - 60));
  const oosBt = runBacktest(oosSlice, signal, market);

  return {
    market,
    trainRange: { from: candles[60]?.t ?? candles[0].t, to: candles[split - 1].t, samples: trainData.X.length },
    testRange: { from: candles[split].t, to: candles[candles.length - 1].t, days: candles.length - split },
    model,
    threshold,
    quantile,
    inSample: inSampleBt.metrics,
    outOfSample: oosBt.metrics,
    oosEquity: oosBt.equity.slice(60), // 워밍업 구간 제외한 순수 OOS 커브
  };
}
