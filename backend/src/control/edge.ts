import type { Target } from "./plane.js";

/**
 * 기대 엣지 게이트 — "다음 매매까지 수수료보다 큰 수익을 낼 확신이 있을 때만 집행한다".
 *
 * 무엇을 재나: 이 결정이 장부를 현재 비중에서 목표 비중으로 옮길 때
 *   비용   = Σ|Δw| × (수수료 + 슬리피지)                      … 편도 거래마다 문다
 *   기대   = Σ Δw_m × μ_m × H                                 … 옮긴 만큼의 증분 수익 (다음 집행 가능 시점까지 H마크)
 *   불확실 = sqrt(Σ Δw_m² × σ_m² × H)                         … 시장별 독립 가정
 *   하한   = 기대 − z × 불확실
 * μ_m, σ_m 은 시장별 5분 마크 수익률의 지수가중 평균·표준편차(반감기 halfLifeMarks) — 협의회가 매 틱 실시세로 갱신한다.
 * 통과 조건: 하한 > 비용. 즉 최근 흐름이 비용을 넘길 만큼 뚜렷하고(기대), 그 흐름이 잡음보다 크다(z)는 두 조건.
 *
 * 정직성: 이건 예측이 아니라 "최근 드리프트가 비용을 정당화하는가"의 검사다. 흐름이 없으면(횡보) 기대≈0 < 비용이라
 * 거래하지 않는다 — 그게 이 게이트의 목적(잔거래 억제)이다. 이력이 부족한 시장은 기대에 넣지 않고 coverage로 드러낸다.
 */

export interface MarketDrift {
  n: number;
  /** 마크당 수익률 EW 평균 */
  mean: number;
  /** 마크당 수익률 EW 분산 */
  var: number;
  lastPx: number;
  lastAt: string;
}

export function updateDrift(prev: MarketDrift | undefined, px: number, now: string, halfLifeMarks: number): MarketDrift {
  if (!(px > 0)) return prev ?? { n: 0, mean: 0, var: 0, lastPx: 0, lastAt: now };
  if (!prev || !(prev.lastPx > 0)) return { n: 0, mean: 0, var: 0, lastPx: px, lastAt: now };
  const r = px / prev.lastPx - 1;
  const alpha = 1 - Math.pow(2, -1 / Math.max(1, halfLifeMarks));
  // 초반은 단순 평균처럼 (1/n), 이후 EW — 첫 몇 마크가 과대 반영되지 않게
  const a = prev.n + 1 < 1 / alpha ? 1 / (prev.n + 1) : alpha;
  const mean = prev.mean + a * (r - prev.mean);
  const v = (1 - a) * (prev.var + a * (r - prev.mean) * (r - prev.mean));
  return { n: prev.n + 1, mean, var: v, lastPx: px, lastAt: now };
}

export interface EdgeRead {
  /** 리밸런스 비용 (% of equity) */
  costPct: number;
  /** 다음 집행까지 기대 증분 수익 (% of equity) */
  expectedPct: number;
  /** 그 불확실성 1σ (% of equity) */
  sdPct: number;
  /** 기대 − z·σ */
  lowerPct: number;
  horizonMarks: number;
  z: number;
  /** |Δw| 중 드리프트 이력이 충분한 비율 (0~1) */
  coverage: number;
  pass: boolean;
  why: string;
}

export function edgeGate(p: {
  holdings: Target[];
  targets: Target[];
  drift: Record<string, MarketDrift>;
  horizonMarks: number;
  /** 편도 비용 (수수료+슬리피지), 퍼센트 단위 (예: 0.10) */
  oneWayCostPct: number;
  z: number;
  /** 시장별 최소 마크 수 — 미만이면 그 시장은 기대에서 제외 */
  minMarks: number;
  /** coverage 가 이 아래면 판단 불가로 실패 */
  minCoverage?: number;
}): EdgeRead {
  const cur = new Map(p.holdings.map((h) => [h.market, h.weightPct]));
  const tgt = new Map(p.targets.map((t) => [t.market, t.weightPct]));
  const H = Math.max(1, p.horizonMarks);
  let absDw = 0, covered = 0, exp = 0, v = 0;
  for (const m of new Set([...cur.keys(), ...tgt.keys()])) {
    const dw = ((tgt.get(m) ?? 0) - (cur.get(m) ?? 0)) / 100;
    if (Math.abs(dw) < 1e-9) continue;
    absDw += Math.abs(dw);
    const d = p.drift[m];
    if (!d || d.n < p.minMarks) continue;
    covered += Math.abs(dw);
    exp += dw * d.mean * H;
    v += dw * dw * d.var * H;
  }
  const costPct = absDw * p.oneWayCostPct;
  const expectedPct = exp * 100;
  const sdPct = Math.sqrt(Math.max(0, v)) * 100;
  const lowerPct = expectedPct - p.z * sdPct;
  const coverage = absDw > 0 ? covered / absDw : 1;
  const minCov = p.minCoverage ?? 0.5;
  const f = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
  if (absDw === 0) return { costPct: 0, expectedPct: 0, sdPct: 0, lowerPct: 0, horizonMarks: H, z: p.z, coverage: 1, pass: false, why: "no change in weights — nothing to trade" };
  if (coverage < minCov) return { costPct: +costPct.toFixed(4), expectedPct: +expectedPct.toFixed(4), sdPct: +sdPct.toFixed(4), lowerPct: +lowerPct.toFixed(4), horizonMarks: H, z: p.z, coverage: +coverage.toFixed(2), pass: false, why: `drift history covers only ${(coverage * 100).toFixed(0)}% of the turnover (< ${(minCov * 100).toFixed(0)}%) — not enough evidence to pay ${costPct.toFixed(3)}%` };
  const pass = lowerPct > costPct;
  const why = pass
    ? `expected edge ${f(expectedPct)} (lower ${f(lowerPct)} at z=${p.z}) > cost ${costPct.toFixed(3)}% over ${H} marks — worth trading`
    : `expected edge ${f(expectedPct)} (lower ${f(lowerPct)} at z=${p.z}) ≤ cost ${costPct.toFixed(3)}% over ${H} marks — not worth the fees`;
  return { costPct: +costPct.toFixed(4), expectedPct: +expectedPct.toFixed(4), sdPct: +sdPct.toFixed(4), lowerPct: +lowerPct.toFixed(4), horizonMarks: H, z: p.z, coverage: +coverage.toFixed(2), pass, why };
}
