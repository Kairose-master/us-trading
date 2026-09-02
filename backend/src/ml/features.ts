import type { BtCandle } from "../crypto/backtest.js";
import { rsiAt } from "../crypto/backtest.js";

/**
 * ML 피처 추출 — 순수 함수 (릴3 "Model Lab"의 데이터 준비부).
 * 캔들 i까지의 정보만으로 피처를 만들고, 라벨은 i+1 수익의 부호다 —
 * 백테스트와 같은 규약(룩어헤드 없음). 프론트 lib/ml/features.ts와 동일 로직.
 */

export const FEATURE_NAMES = [
  "bias",
  "rsi14",       // (rsi-50)/50 → [-1,1]
  "mom5",        // 5일 수익률 tanh 스케일
  "mom20",       // 20일 수익률 tanh 스케일
  "volRatio",    // 단기/장기 실현변동성 비율 - 1
  "volumeZ",     // 거래량 20일 z-score (클립)
  "range",       // 당일 고저폭 / 종가
  "closePos",    // 종가가 당일 고저 범위 어디에 있나 [-1,1]
] as const;

export type FeatureVector = number[]; // FEATURE_NAMES 순서

function realizedVol(closes: number[], end: number, period: number): number {
  if (end + 1 < period + 1) return NaN;
  const rets: number[] = [];
  for (let i = end - period + 1; i <= end; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
}

/** 캔들 i 시점의 피처 벡터. 워밍업 부족이면 null. */
export function featuresAt(candles: BtCandle[], i: number): FeatureVector | null {
  if (i < 60) return null; // 최장 룩백(60일 변동성) 워밍업
  const closes = candles.map((c) => c.c);
  const c = candles[i];

  const rsi = (rsiAt(closes, i) - 50) / 50;
  const mom5 = Math.tanh(((closes[i] - closes[i - 5]) / closes[i - 5]) * 10);
  const mom20 = Math.tanh(((closes[i] - closes[i - 20]) / closes[i - 20]) * 5);

  const rvS = realizedVol(closes, i, 10);
  const rvL = realizedVol(closes, i, 60);
  const volRatio = Number.isNaN(rvS) || Number.isNaN(rvL) || rvL === 0 ? 0 : Math.tanh(rvS / rvL - 1);

  let vMean = 0;
  for (let k = i - 19; k <= i; k++) vMean += candles[k].v;
  vMean /= 20;
  let vVar = 0;
  for (let k = i - 19; k <= i; k++) vVar += (candles[k].v - vMean) ** 2;
  const vSd = Math.sqrt(vVar / 20);
  const volumeZ = vSd > 0 ? Math.max(-3, Math.min(3, (c.v - vMean) / vSd)) / 3 : 0;

  const range = c.c > 0 ? Math.min(1, (c.h - c.l) / c.c) : 0;
  const closePos = c.h > c.l ? ((c.c - c.l) / (c.h - c.l)) * 2 - 1 : 0;

  return [1, rsi, mom5, mom20, volRatio, volumeZ, range, closePos];
}

export interface Dataset {
  X: FeatureVector[];
  /** 라벨: i+1 종가수익 > 0 이면 1, 아니면 0 */
  y: number[];
  /** 각 샘플이 어느 캔들 인덱스에서 왔나 (검증 백테스트 매핑용) */
  index: number[];
}

/** [from, to) 구간에서 데이터셋 구성. 마지막 캔들은 라벨이 없어 제외. */
export function buildDataset(candles: BtCandle[], from: number, to: number): Dataset {
  const X: FeatureVector[] = [];
  const y: number[] = [];
  const index: number[] = [];
  const end = Math.min(to, candles.length - 1);
  for (let i = Math.max(from, 60); i < end; i++) {
    const f = featuresAt(candles, i);
    if (!f) continue;
    X.push(f);
    y.push(candles[i + 1].c > candles[i].c ? 1 : 0);
    index.push(i);
  }
  return { X, y, index };
}
