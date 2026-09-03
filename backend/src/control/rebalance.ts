import type { Target } from "./council.js";

/** 편도 회전율(%) — |목표 − 현재| 합의 절반 */
export function turnoverPct(current: Target[], targets: Target[]): number {
  const cur = new Map(current.map((h) => [h.market, h.weightPct]));
  let want = 0;
  for (const m of new Set([...cur.keys(), ...targets.map((t) => t.market)])) want += Math.abs((targets.find((t) => t.market === m)?.weightPct ?? 0) - (cur.get(m) ?? 0));
  return want / 2;
}

/**
 * 최대 회전: 목표가 현재와 너무 다르면 그 방향으로 maxTurnoverPct만큼만 움직인다 (부분 리밸런스).
 * 진화 스쿼드가 바뀌면 56%가 한 시간에 회전했다(2026-09-03 01:20) — 목표까지는 여러 집행에 걸쳐 조금씩 간다.
 */
export function capTurnover(current: Target[], targets: Target[], maxTurnoverPct: number): { targets: Target[]; turnoverPct: number; capped: boolean; note: string | null } {
  const want = turnoverPct(current, targets);
  if (!(want > maxTurnoverPct) || want <= 0) return { targets, turnoverPct: want, capped: false, note: null };
  const k = maxTurnoverPct / want;
  const cur = new Map(current.map((h) => [h.market, h.weightPct]));
  const blended: Target[] = [];
  for (const m of new Set([...cur.keys(), ...targets.map((t) => t.market)])) {
    const c = cur.get(m) ?? 0, t = targets.find((x) => x.market === m)?.weightPct ?? 0;
    const w = +(c + k * (t - c)).toFixed(2);
    if (w >= 0.5) blended.push({ market: m, weightPct: w });
  }
  return { targets: blended, turnoverPct: want, capped: true, note: `risk: turnover ${want.toFixed(1)}% → capped ${maxTurnoverPct}% (moved ${(k * 100).toFixed(0)}% of the way toward the council target)` };
}
