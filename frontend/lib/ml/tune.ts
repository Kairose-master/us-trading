import type { CryptoCandle as BtCandle } from "@/lib/crypto/upbit";
import { runBacktest, type BacktestResult } from "@/lib/crypto/backtest";
import { buildDataset } from "@/lib/ml/features";
import { trainLogistic, predictProb, rng, type TrainParams } from "@/lib/ml/train";
import { modelAsSignal } from "@/lib/ml/validate";

/**
 * 하이퍼파라미터 자동 탐색 — "일일이 설정하지 않아도 되게".
 *
 * 왜 문자 그대로의 경사하강이 아닌가: 학습률/에폭/분위수는 학습 루프 전체를
 * 통과해야 성과가 나오고, 그 목적함수(검증 백테스트 성과)는 미분 불가능하고
 * 노이즈가 크다. 그래서 파생 없는(derivative-free) 최적화를 쓴다:
 *   1) 시드 고정 랜덤 탐색으로 공간을 넓게 훑고
 *   2) 최적점 주변을 좌표 하강(pattern search)으로 정련한다 — 각 축을
 *      ±스텝 유한차분으로 찔러 개선 방향으로 이동, 막히면 스텝 축소.
 *      경사하강의 "기울기"를 근사 평가로 대신하는 사촌이다.
 *
 * 오염 방지가 이 파일의 진짜 요점: 튜너가 OOS를 보고 고르면 OOS는 더 이상
 * out-of-sample이 아니다. 그래서 3분할을 강제한다 —
 *   학습 60% → 모델 파라미터(가중치)가 보는 구간
 *   검증 20% → 하이퍼파라미터(튜너)가 보는 구간 (목적함수)
 *   홀드아웃 20% → 아무도 못 본 최종 성적표. 이 숫자만 신뢰한다.
 */

export interface TunableParams extends TrainParams {
  quantile: number;
}

export interface Trial {
  id: number;
  kind: "random" | "refine";
  params: TunableParams;
  /** 검증창 Sharpe (목적함수) */
  objective: number;
  valAnnualPct: number;
  valTrades: number;
}

export interface TuneResult {
  market: string;
  splits: { trainEnd: string; valEnd: string; holdoutEnd: string };
  trials: Trial[];
  best: TunableParams;
  bestObjective: number;
  /** 최적 파라미터로 학습(train+val 재학습) 후 홀드아웃 백테스트 — 튜너가 못 본 구간 */
  holdout: BacktestResult["metrics"];
  holdoutEquity: BacktestResult["equity"];
  /** 홀드아웃용 최종 모델의 검증 리포트 형태 요약 */
  finalThreshold: number;
}

const WARMUP = 60;

export interface TuneOpts {
  randomTrials: number; // 기본 20
  refineSteps: number;  // 기본 10
  seed: number;
}

export const DEFAULT_TUNE: TuneOpts = { randomTrials: 20, refineSteps: 10, seed: 7 };

/** 한 파라미터 조합을 평가: 학습창 학습 → 검증창 백테스트 → Sharpe */
function evaluate(
  candles: BtCandle[],
  trainEnd: number,
  valEnd: number,
  p: TunableParams,
): { objective: number; valAnnualPct: number; valTrades: number } {
  const data = buildDataset(candles, 0, trainEnd);
  if (data.X.length < 40) return { objective: -Infinity, valAnnualPct: 0, valTrades: 0 };
  const model = trainLogistic(data, p);
  const probs = data.X.map((x) => predictProb(model.weights, x)).sort((a, b) => a - b);
  const qi = Math.min(probs.length - 1, Math.max(0, Math.floor(probs.length * p.quantile)));
  const signal = modelAsSignal(model, probs[qi]);
  const bt = runBacktest(candles.slice(Math.max(0, trainEnd - WARMUP), valEnd), signal, "val");
  const m = bt.metrics;
  // 거래가 거의 없는 조합은 Sharpe가 우연히 좋아 보일 수 있다 — 최소 거래수 페널티
  const penalty = m.trades < 3 ? -1 : 0;
  return { objective: +(m.sharpe + penalty).toFixed(4), valAnnualPct: m.annualReturnPct, valTrades: m.trades };
}

function clampParams(p: TunableParams): TunableParams {
  return {
    learningRate: Math.min(0.3, Math.max(0.005, p.learningRate)),
    epochs: Math.min(200, Math.max(10, Math.round(p.epochs))),
    l2: Math.min(0.05, Math.max(0.00001, p.l2)),
    batchSize: Math.min(64, Math.max(8, Math.round(p.batchSize))),
    seed: p.seed,
    quantile: Math.min(0.85, Math.max(0.5, p.quantile)),
  };
}

export function tuneHyperparams(
  candles: BtCandle[],
  market: string,
  opts: TuneOpts = DEFAULT_TUNE,
  onTrial?: (t: Trial) => void,
): TuneResult {
  const n = candles.length;
  const trainEnd = Math.floor(n * 0.6);
  const valEnd = Math.floor(n * 0.8);
  const random = rng(opts.seed);
  const trials: Trial[] = [];
  let best: TunableParams | null = null;
  let bestObj = -Infinity;
  let id = 0;

  const record = (kind: Trial["kind"], p: TunableParams) => {
    const { objective, valAnnualPct, valTrades } = evaluate(candles, trainEnd, valEnd, p);
    const t: Trial = { id: ++id, kind, params: p, objective, valAnnualPct, valTrades };
    trials.push(t);
    onTrial?.(t);
    if (objective > bestObj) {
      bestObj = objective;
      best = p;
    }
    return t;
  };

  // 1) 랜덤 탐색 — lr/l2는 로그 스케일
  for (let i = 0; i < opts.randomTrials; i++) {
    record(
      "random",
      clampParams({
        learningRate: Math.exp(Math.log(0.005) + random() * (Math.log(0.3) - Math.log(0.005))),
        epochs: 10 + Math.round(random() * 190),
        l2: Math.exp(Math.log(0.00001) + random() * (Math.log(0.05) - Math.log(0.00001))),
        batchSize: [8, 16, 32, 64][Math.floor(random() * 4)],
        seed: 42,
        quantile: 0.5 + random() * 0.35,
      }),
    );
  }

  // 2) 좌표 하강 정련 — 각 축을 ±유한차분으로 찔러 개선되면 그쪽으로 이동,
  //    한 바퀴 동안 개선이 없으면 스텝을 줄인다 (pattern search)
  let step = 1; // 스텝 배율
  for (let s = 0; s < opts.refineSteps && best; s++) {
    const objBefore = bestObj;
    const dims: Array<(p: TunableParams, dir: 1 | -1) => TunableParams> = [
      (p, d) => ({ ...p, learningRate: p.learningRate * (d === 1 ? 1 + 0.5 * step : 1 / (1 + 0.5 * step)) }),
      (p, d) => ({ ...p, epochs: p.epochs + d * Math.max(5, Math.round(20 * step)) }),
      (p, d) => ({ ...p, l2: p.l2 * (d === 1 ? 1 + 0.8 * step : 1 / (1 + 0.8 * step)) }),
      (p, d) => ({ ...p, quantile: p.quantile + d * 0.05 * step }),
    ];
    for (const move of dims) {
      for (const dir of [1, -1] as const) {
        const cand = clampParams(move(best!, dir));
        if (JSON.stringify(cand) === JSON.stringify(best)) continue;
        record("refine", cand); // record()가 개선 시 best/bestObj를 갱신한다
      }
    }
    if (bestObj <= objBefore + 1e-9) step *= 0.6;
  }

  if (!best) throw new Error("탐색 실패 — 데이터가 부족합니다");
  const finalBest: TunableParams = best;

  // 3) 최종: train+val 전체로 재학습 → 홀드아웃(튜너 미접촉) 백테스트
  const finalData = buildDataset(candles, 0, valEnd);
  const finalModel = trainLogistic(finalData, finalBest);
  const probs = finalData.X.map((x) => predictProb(finalModel.weights, x)).sort((a, b) => a - b);
  const qi = Math.min(probs.length - 1, Math.max(0, Math.floor(probs.length * finalBest.quantile)));
  const threshold = +probs[qi].toFixed(5);
  const holdoutBt = runBacktest(candles.slice(Math.max(0, valEnd - WARMUP)), modelAsSignal(finalModel, threshold), market);

  return {
    market,
    splits: {
      trainEnd: candles[trainEnd - 1].t,
      valEnd: candles[valEnd - 1].t,
      holdoutEnd: candles[n - 1].t,
    },
    trials,
    best: finalBest,
    bestObjective: bestObj,
    holdout: holdoutBt.metrics,
    holdoutEquity: holdoutBt.equity.slice(WARMUP),
    finalThreshold: threshold,
  };
}
