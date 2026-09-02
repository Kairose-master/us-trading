import type { BtCandle } from "../crypto/backtest.js";
import { SIGNALS, DEFAULT_COSTS } from "../crypto/backtest.js";
import { fitHmm, type HmmResult } from "./regime.js";
import { fitGarch, type GarchResult } from "./garch.js";
import { exponentialWeights, type AllocatorResult, type ExpertSeries } from "./allocator.js";
import { riskMetrics, kellyFraction, type RiskMetrics, type KellyResult } from "./risk.js";
import { backtestStats, type BacktestStats } from "./stats.js";

/**
 * 퀀트 코어 통합 리포트 — 수학 지도의 closed-loop 한 바퀴:
 *   Observe(캔들) → Infer(HMM 레짐 + GARCH 변동성) → Allocate(지수 가중 전문가)
 *   → Risk(VaR/ES/Kelly) → Evaluate(부트스트랩 + 다중검정)
 * 모든 숫자는 실데이터에서 실계산된다. 프론트 lib/quant/report.ts와 동일 로직.
 */

export interface QuantReport {
  market: string;
  days: number;
  dates: string[]; // 수익률 축 (n-1)
  returns: number[];
  regime: HmmResult;
  garch: GarchResult;
  allocator: AllocatorResult;
  risk: RiskMetrics;
  benchmarkRisk: RiskMetrics;
  kelly: KellyResult;
  stats: BacktestStats;
}

export function buildQuantReport(candles: BtCandle[], market: string): QuantReport {
  const n = candles.length;
  if (n < 200) throw new Error(`캔들 부족 (${n}개)`);
  const returns: number[] = [];
  const dates: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    returns.push(candles[i + 1].c / candles[i].c - 1);
    dates.push(candles[i + 1].t);
  }

  const regime = fitHmm(returns, 3);
  const garch = fitGarch(returns);

  // 전문가 = 룰 시그널 4종 + 단순보유. 룩어헤드 없음: t 시그널 → t+1 수익.
  // 수수료+슬리피지(편도)를 포지션 변화(turnover)마다 차감 — 무비용 숫자는 상한선일 뿐.
  const costRate = (DEFAULT_COSTS.feePct + DEFAULT_COSTS.slipPct) / 100;
  const withCosts = (positions: Array<0 | 1>): number[] => {
    let prev: 0 | 1 = 0;
    return returns.map((r, t) => {
      const pos = positions[t];
      const turnover = Math.abs(pos - prev);
      prev = pos;
      return (pos === 1 ? r : 0) - turnover * costRate;
    });
  };
  const experts: ExpertSeries[] = [
    ...SIGNALS.map((s) => ({
      id: s.id,
      name: s.name,
      returns: withCosts(returns.map((_, t) => s.position(candles, t))),
    })),
    { id: "buy-hold", name: "단순보유", returns: withCosts(returns.map(() => 1 as const)) },
  ];
  const allocator = exponentialWeights(experts, 10);

  const risk = riskMetrics(allocator.blended);
  const benchmarkRisk = riskMetrics(returns);
  const kelly = kellyFraction(allocator.blended);
  const stats = backtestStats(allocator.blended, experts.length);

  return { market, days: n, dates, returns, regime, garch, allocator, risk, benchmarkRisk, kelly, stats };
}
