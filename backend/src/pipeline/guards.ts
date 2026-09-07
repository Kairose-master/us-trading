import type { PipelineTick } from './types.js';

/** Tick-frequency safeguards, not annualized risk estimates or a return forecast. */
export const POLICY = Object.freeze({ warmup: 21, maxAgeMs: 120_000, sentimentAgeMs: 6 * 3_600_000,
  maxSpreadBps: 50, volatilityFloorPct: 0.05, grossExposurePct: 90 });

export function validateTick(q: PipelineTick, now: number, previous?: number): string | null {
  if (!q.symbol?.trim() || !Number.isFinite(q.last) || q.last <= 0) return 'INVALID_PRICE';
  if (![q.bid, q.ask, q.bidSize, q.askSize, q.volume].every(x => Number.isFinite(x) && x >= 0)) return 'INVALID_MARKET_DATA';
  if ((q.bid > 0 || q.ask > 0) && (!(q.bid > 0 && q.ask > 0) || q.ask < q.bid)) return 'CROSSED_OR_PARTIAL_BOOK';
  if (q.replay) return 'HISTORICAL_REPLAY';
  if (q.observedAt !== undefined) {
    if (!Number.isFinite(q.observedAt) || q.observedAt > now + 5_000 || now - q.observedAt > POLICY.maxAgeMs) return 'STALE_OR_FUTURE_TICK';
    if (previous !== undefined && q.observedAt <= previous) return 'OUT_OF_ORDER_TICK';
  }
  return null;
}

export function liquidityBlock(q: PipelineTick | undefined): string | null {
  if (!q || q.bid <= 0 || q.ask <= 0 || q.bidSize <= 0 || q.askSize <= 0) return 'ORDER_BOOK_UNAVAILABLE';
  return (q.ask - q.bid) / q.last * 10_000 > POLICY.maxSpreadBps ? 'SPREAD_TOO_WIDE' : null;
}

/** Capped alpha × confidence / volatility allocation. Residual stays in cash. */
export function allocateRisk(scores: Array<{ symbol: string; alpha: number; confidence: number; volatilityPct: number }>, cap: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!Number.isFinite(cap) || cap <= 0) return out;
  const eligible = scores.filter(s => [s.alpha, s.confidence, s.volatilityPct].every(Number.isFinite) && s.alpha > 0.05 && s.confidence > 0 && s.volatilityPct >= 0);
  const weighted = eligible.map(s => ({ symbol: s.symbol, score: s.alpha * Math.min(1, s.confidence) / Math.max(POLICY.volatilityFloorPct, s.volatilityPct) }));
  const sum = weighted.reduce((n, s) => n + s.score, 0);
  for (const s of weighted) out.set(s.symbol, Math.min(cap, POLICY.grossExposurePct * s.score / sum));
  return out;
}
