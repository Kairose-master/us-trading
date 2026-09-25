import type { FeedEvent } from "./feed.js";
import type { Lot } from "./ledger.js";

/**
 * 카피 트레이딩 규칙 — 순수 함수. 추종 지갑의 체결 이벤트 하나와 현재 장부 상태를 받아 "무엇을 하나"를 돌려준다.
 * 제어 평면의 엔진 귀속과 같은 구조: 지갑 = 엔진, standing = 실현수익으로 움직이는 가중치.
 *
 *   진입: 추종 지갑이 사면 우리도 산다. 크기 = min(포지션 상한, 에쿼티 × 위험% × standing). 이미 그 지갑을 따라 그 토큰을
 *         들고 있으면 추가하지 않는다. 총노출·현금 하한을 넘기면 안 산다. 지갑의 매수가 먼지(minLeaderSol 미만)면 무시 — 노이즈다.
 *   청산: 추종 지갑이 팔면 그 비율만큼 판다(절반 넘게 팔면 전량). 시간 정지(maxHoldMin)·손절(stopLossPct)·
 *         고점 대비 되돌림(trailingPct, 이익 구간에서만)은 지갑과 무관하게 우리 로트에 건다 — 지갑이 안 팔고 물리는 것까지 따라가지 않는다.
 */

export interface CopyPolicy {
  /** 포지션당 상한 (SOL) */
  maxPositionSol: number;
  /** 에쿼티 대비 1회 위험 % (standing 1.0 기준) */
  riskPct: number;
  grossMaxPct: number;
  cashFloorPct: number;
  maxLots: number;
  minLeaderSol: number;
  maxHoldMin: number;
  stopLossPct: number;
  trailingPct: number;
  /** 추종 지갑 수 상한 */
  followMax: number;
  /** standing 갱신 학습률 — standing ← standing × e^(eta × clamp(r, ±25%)). 한 방(+300%)이 standing을 단번에 최대로 못 올린다 */
  eta: number;
  /** 누적 실현수익이 이 아래로 떨어지면 추종 해제 (굶어 죽는다) */
  dropAtPct: number;
  dropAfterCloses: number;
  /** 일 손실 정지 (에쿼티 % ) */
  dailyStopPct: number;
  /** 졸업 토큰의 거래를 관측하는 창(분) — 지갑 발견용 */
  discoveryWindowMin: number;
  discoveryMaxMints: number;
  rescoreMin: number;
}

export const DEFAULT_COPY_POLICY: CopyPolicy = { maxPositionSol: 0.3, riskPct: 2, grossMaxPct: 60, cashFloorPct: 20, maxLots: 12, minLeaderSol: 0.05, maxHoldMin: 120, stopLossPct: 35, trailingPct: 30, followMax: 20, eta: 2, dropAtPct: -50, dropAfterCloses: 5, dailyStopPct: 20, discoveryWindowMin: 60, discoveryMaxMints: 30, rescoreMin: 30 };

export interface Follow { wallet: string; standing: number; since: string; source: "scored" | "manual"; closes: number; wins: number; cumPct: number; returns: number[] }

export type CopyAction =
  | { type: "buy"; mint: string; solIn: number; via: string; reason: string }
  | { type: "sell"; lotId: string; fraction: number; reason: string }
  | { type: "skip"; reason: string };

export function sizeFor(p: CopyPolicy, equitySol: number, standing: number): number {
  return Math.max(0, Math.min(p.maxPositionSol, equitySol * (p.riskPct / 100) * standing));
}

export function onLeaderTrade(ev: Extract<FeedEvent, { kind: "trade" }>, ctx: { policy: CopyPolicy; follow: Follow | undefined; lots: Lot[]; equitySol: number; cashSol: number; positionsSol: number; paused: boolean }): CopyAction[] {
  const { policy: p, follow } = ctx;
  if (!follow) return [{ type: "skip", reason: "not a followed wallet" }];
  const mine = ctx.lots.filter((l) => l.mint === ev.mint && l.via === ev.wallet);
  if (ev.side === "sell") {
    if (!mine.length) return [{ type: "skip", reason: "leader sold — we hold nothing via them" }];
    const before = ev.tokens + ev.newTokenBalance;
    const frac = before > 0 ? ev.tokens / before : 1;
    const fraction = frac >= 0.5 ? 1 : frac;
    return mine.map((l) => ({ type: "sell" as const, lotId: l.id, fraction, reason: `leader ${ev.wallet.slice(0, 6)} sold ${(frac * 100).toFixed(0)}%` }));
  }
  if (ctx.paused) return [{ type: "skip", reason: "paused" }];
  if (ev.sol < p.minLeaderSol) return [{ type: "skip", reason: `leader buy ${ev.sol.toFixed(4)} SOL < minLeaderSol` }];
  if (mine.length) return [{ type: "skip", reason: "already holding via this leader" }];
  if (ctx.lots.length >= p.maxLots) return [{ type: "skip", reason: `maxLots ${p.maxLots}` }];
  let size = sizeFor(p, ctx.equitySol, follow.standing);
  const grossRoom = ctx.equitySol * (p.grossMaxPct / 100) - ctx.positionsSol;
  const cashRoom = ctx.cashSol - ctx.equitySol * (p.cashFloorPct / 100);
  size = Math.min(size, grossRoom, cashRoom);
  if (size < 0.005) return [{ type: "skip", reason: `no room: gross ${grossRoom.toFixed(3)} / cash ${cashRoom.toFixed(3)} SOL` }];
  return [{ type: "buy", mint: ev.mint, solIn: +size.toFixed(6), via: ev.wallet, reason: `copy ${ev.wallet.slice(0, 6)} buy ${ev.sol.toFixed(3)} SOL (standing ${follow.standing.toFixed(2)})` }];
}

/** 지갑과 무관한 로트 청산 규칙 — 매 마킹 뒤에 돈다 */
export function lotExits(lots: Lot[], p: CopyPolicy, now = Date.now()): CopyAction[] {
  const out: CopyAction[] = [];
  for (const l of lots) {
    const holdMin = (now - Date.parse(l.openedAt)) / 60_000;
    const pnlPct = l.costSol > 0 ? ((l.markSol - l.costSol) / l.costSol) * 100 : 0;
    const peakPct = l.costSol > 0 ? ((l.peakMarkSol - l.costSol) / l.costSol) * 100 : 0;
    const fromPeak = l.peakMarkSol > 0 ? ((l.markSol - l.peakMarkSol) / l.peakMarkSol) * 100 : 0;
    if (pnlPct <= -p.stopLossPct) out.push({ type: "sell", lotId: l.id, fraction: 1, reason: `stop-loss ${pnlPct.toFixed(1)}%` });
    else if (peakPct >= 20 && fromPeak <= -p.trailingPct) out.push({ type: "sell", lotId: l.id, fraction: 1, reason: `trailing: ${fromPeak.toFixed(1)}% from peak (+${peakPct.toFixed(0)}%)` });
    else if (holdMin >= p.maxHoldMin) out.push({ type: "sell", lotId: l.id, fraction: 1, reason: `time stop ${holdMin.toFixed(0)}m` });
  }
  return out;
}

/** 실현 결과로 standing 갱신 — 지수 가중, [0.1, 2] 클램프. 굶주림(누적 손실)이면 drop */
export function applyOutcome(f: Follow, pnlPct: number, p: CopyPolicy): { follow: Follow; drop: boolean } {
  const r = pnlPct / 100;
  const returns = [...f.returns.slice(-199), +r.toFixed(4)];
  const cumPct = +((returns.reduce((a, x) => a * (1 + x), 1) - 1) * 100).toFixed(2);
  const standing = +Math.max(0.1, Math.min(2, f.standing * Math.exp(p.eta * Math.max(-0.25, Math.min(0.25, r))))).toFixed(3);
  const nf: Follow = { ...f, standing, closes: f.closes + 1, wins: f.wins + (pnlPct > 0 ? 1 : 0), cumPct, returns };
  return { follow: nf, drop: nf.closes >= p.dropAfterCloses && cumPct <= p.dropAtPct };
}
