import { AMM_FEE_PCT, CURVE_FEE_PCT, liquidationValue, quoteBuy, quoteSell, type CurveState } from "./curve.js";

/**
 * SOL 페이퍼 장부 — 단위는 KRW가 아니라 SOL이다(환산은 표시용). 로트(lot) 단위로 기록한다:
 * 같은 토큰이라도 "어느 지갑을 따라 산 것인가"가 달라야 귀속이 되기 때문이다.
 *
 * 체결 규칙 (README "비용 없는 페이퍼 기록은 자기기만" 그대로):
 *   커브(pool=pump)   → 본딩커브 수식으로 정확히 (curve.ts) + 지연 슬리피지(latencySlipPct — 우리 트랜잭션이 실리기 전 남이 먼저 산 몫)
 *   AMM(pool=pump-amm) → 관측 체결가 × (1 + ammImpactPct + latencySlipPct) + 수수료 0.25% (풀 준비금을 모르므로 임팩트는 가정이다 — 표시에 남긴다)
 *   우선순위 수수료   → 건당 priorityFeeSol (Jito 팁/compute fee 합, SOL)
 * 평가액은 한계가×수량이 아니라 **지금 전부 팔면 받는 SOL**(liquidationValue)이다.
 */

export interface Lot {
  id: string;
  mint: string;
  symbol: string;
  /** 누구를 따라 샀나 — 지갑 주소 또는 "rule:…" */
  via: string;
  tokens: number;
  /** 들어간 SOL 총액 (수수료·우선순위 수수료 포함) */
  costSol: number;
  openedAt: string;
  pool: string;
  bondingCurveKey: string | null;
  /** 마지막 마킹 — 전량 청산 시 받을 SOL */
  markSol: number;
  markAt: string;
  peakMarkSol: number;
  /** 마지막으로 본 커브 상태 (AMM이면 null, 가격만) */
  curve: CurveState | null;
  lastPrice: number;
  /** 최근 마킹 이력 (러그 감시 — 90초 안의 급락을 본다) */
  marks?: Array<{ ts: number; markSol: number }>;
  /** 익절 사다리에서 이미 판 단계 (%) — 같은 단계를 두 번 팔지 않게 */
  ladderDone?: number[];
}

export interface PaperOrder {
  id: string;
  ts: string;
  lotId: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  tokens: number;
  /** 지갑 변화 (매수: 나간 SOL, 매도: 들어온 SOL) — 수수료 반영 후 */
  sol: number;
  feeSol: number;
  priorityFeeSol: number;
  impactPct: number;
  slipPct: number;
  pool: string;
  via: string;
  reason: string;
  /** 매도에만 — 이 로트(의 일부)에서 실현한 손익 */
  pnlSol?: number;
  pnlPct?: number;
  holdMin?: number;
  /** 실주문 — 온체인 트랜잭션 서명 */
  signature?: string;
}

export interface LedgerCosts { latencySlipPct: number; ammImpactPct: number; priorityFeeSol: number }
export const DEFAULT_LEDGER_COSTS: LedgerCosts = { latencySlipPct: 0.5, ammImpactPct: 1.0, priorityFeeSol: 0.0005 };

export interface LedgerSnapshot { cashSol: number; startSol: number; since: string; lots: Lot[]; orders: PaperOrder[]; seq: number }

export class PumpLedger {
  cashSol: number;
  startSol: number;
  since: string;
  lots = new Map<string, Lot>();
  orders: PaperOrder[] = [];
  private seq = 0;

  constructor(startSol: number, public costs: LedgerCosts = DEFAULT_LEDGER_COSTS) { this.cashSol = startSol; this.startSol = startSol; this.since = new Date().toISOString(); }

  snapshot(): LedgerSnapshot { return { cashSol: this.cashSol, startSol: this.startSol, since: this.since, lots: [...this.lots.values()], orders: this.orders.slice(-2000), seq: this.seq }; }
  static restore(s: LedgerSnapshot, costs: LedgerCosts): PumpLedger {
    const l = new PumpLedger(s.startSol, costs); l.cashSol = s.cashSol; l.since = s.since; l.seq = s.seq ?? 0; l.orders = s.orders ?? [];
    for (const lot of s.lots ?? []) l.lots.set(lot.id, lot);
    return l;
  }

  positionsSol(): number { let s = 0; for (const l of this.lots.values()) s += l.markSol; return s; }
  equitySol(): number { return this.cashSol + this.positionsSol(); }
  lotsOf(mint: string): Lot[] { return [...this.lots.values()].filter((l) => l.mint === mint); }
  heldMints(): string[] { return [...new Set([...this.lots.values()].map((l) => l.mint))]; }

  /** 커브 위 매수. solIn은 우선순위 수수료를 제외한 주문 SOL */
  buy(p: { mint: string; symbol: string; pool: string; bondingCurveKey: string | null; curve: CurveState | null; price: number; solIn: number; via: string; reason: string; ts?: string }): { lot: Lot; order: PaperOrder } | { error: string } {
    const ts = p.ts ?? new Date().toISOString();
    const total = p.solIn + this.costs.priorityFeeSol;
    if (!(p.solIn > 0)) return { error: "solIn must be > 0" };
    if (total > this.cashSol) return { error: `insufficient cash: need ${total.toFixed(4)} SOL, have ${this.cashSol.toFixed(4)}` };
    let tokens: number, feeSol: number, impactPct: number, curveNext: CurveState | null = null, lastPrice: number, markSol: number;
    const slip = this.costs.latencySlipPct;
    if (p.pool === "pump" && p.curve && p.curve.vSol > 0) {
      // 지연: 우리보다 먼저 slip% 만큼의 매수가 커브에 들어갔다고 본다 (준비금을 그만큼 옮긴 뒤 체결)
      const ahead = quoteBuy(p.curve, p.solIn * (slip / 100), 0);
      const f = quoteBuy(ahead.next, p.solIn, CURVE_FEE_PCT);
      tokens = f.tokens; feeSol = f.feeSol; impactPct = f.impactPct; curveNext = f.next; lastPrice = tokens > 0 ? p.solIn / tokens : 0;
      markSol = liquidationValue(curveNext, tokens, CURVE_FEE_PCT);
    } else {
      if (!(p.price > 0)) return { error: "no price for AMM fill" };
      const px = p.price * (1 + (this.costs.ammImpactPct + slip) / 100);
      feeSol = p.solIn * (AMM_FEE_PCT / 100);
      tokens = (p.solIn - feeSol) / px;
      impactPct = +(((px / p.price) - 1) * 100 + AMM_FEE_PCT).toFixed(4);
      lastPrice = px;
      // AMM 평가액: 되팔 때 같은 임팩트+수수료를 다시 문다
      markSol = tokens * p.price * (1 - (this.costs.ammImpactPct + AMM_FEE_PCT) / 100);
    }
    if (!(tokens > 0)) return { error: "fill produced no tokens" };
    this.cashSol -= total;
    const lot: Lot = { id: `L${++this.seq}`, mint: p.mint, symbol: p.symbol, via: p.via, tokens, costSol: total, openedAt: ts, pool: p.pool, bondingCurveKey: p.bondingCurveKey, markSol, markAt: ts, peakMarkSol: markSol, curve: curveNext, lastPrice };
    this.lots.set(lot.id, lot);
    const order: PaperOrder = { id: `O${this.seq}`, ts, lotId: lot.id, mint: p.mint, symbol: p.symbol, side: "buy", tokens, sol: total, feeSol, priorityFeeSol: this.costs.priorityFeeSol, impactPct, slipPct: slip, pool: p.pool, via: p.via, reason: p.reason };
    this.orders.push(order); if (this.orders.length > 5000) this.orders.splice(0, this.orders.length - 5000);
    return { lot, order };
  }

  /** 로트의 fraction(0~1)을 판다. 커브면 수식, AMM이면 마지막 가격 기준 */
  sell(lotId: string, fraction: number, reason: string, ts = new Date().toISOString()): { order: PaperOrder; closed: boolean } | { error: string } {
    const lot = this.lots.get(lotId);
    if (!lot) return { error: `no lot ${lotId}` };
    const frac = Math.max(0, Math.min(1, fraction));
    const tokens = frac >= 0.999 ? lot.tokens : lot.tokens * frac;
    if (!(tokens > 0)) return { error: "nothing to sell" };
    let sol: number, feeSol: number, impactPct: number;
    const slip = this.costs.latencySlipPct;
    if (lot.pool === "pump" && lot.curve && lot.curve.vSol > 0) {
      const ahead = quoteSell(lot.curve, tokens * (slip / 100), 0); // 남이 먼저 판 몫만큼 준비금이 밀린 뒤 체결
      const f = quoteSell(ahead.next, tokens, CURVE_FEE_PCT);
      sol = f.sol; feeSol = f.feeSol; impactPct = f.impactPct; lot.curve = f.next;
    } else {
      const px = lot.lastPrice * (1 - (this.costs.ammImpactPct + slip) / 100);
      const gross = tokens * px; feeSol = gross * (AMM_FEE_PCT / 100); sol = gross - feeSol;
      impactPct = -(this.costs.ammImpactPct + slip + AMM_FEE_PCT);
    }
    sol -= this.costs.priorityFeeSol;
    const costPart = lot.costSol * (tokens / lot.tokens);
    const pnl = sol - costPart;
    this.cashSol += sol;
    lot.tokens -= tokens; lot.costSol -= costPart;
    const closed = lot.tokens <= 1e-9;
    if (closed) this.lots.delete(lot.id); else { lot.markSol = lot.curve ? liquidationValue(lot.curve, lot.tokens, CURVE_FEE_PCT) : lot.tokens * lot.lastPrice * (1 - (this.costs.ammImpactPct + AMM_FEE_PCT) / 100); lot.markAt = ts; }
    const order: PaperOrder = { id: `O${++this.seq}`, ts, lotId: lot.id, mint: lot.mint, symbol: lot.symbol, side: "sell", tokens, sol, feeSol, priorityFeeSol: this.costs.priorityFeeSol, impactPct, slipPct: slip, pool: lot.pool, via: lot.via, reason, pnlSol: +pnl.toFixed(6), pnlPct: costPart > 0 ? +((pnl / costPart) * 100).toFixed(2) : 0, holdMin: +((Date.parse(ts) - Date.parse(lot.openedAt)) / 60_000).toFixed(1) };
    this.orders.push(order); if (this.orders.length > 5000) this.orders.splice(0, this.orders.length - 5000);
    return { order, closed };
  }

  /**
   * 실체결로 로트를 연다 — 체인이 말한 토큰 수와 나간 SOL(수수료·우선순위 수수료 전부 포함)을 그대로 적는다. 추정치 없음.
   * cashSol은 여기서 건드리지 않는다 — 실장부의 현금은 지갑 잔고 동기화가 정한다.
   */
  openFromFill(p: { mint: string; symbol: string; pool: string; bondingCurveKey: string | null; curve: CurveState | null; tokens: number; costSol: number; via: string; reason: string; signature: string; ts?: string }): { lot: Lot; order: PaperOrder } | { error: string } {
    const ts = p.ts ?? new Date().toISOString();
    if (!(p.tokens > 0) || p.costSol < 0) return { error: `fill without tokens/cost: ${p.tokens} / ${p.costSol}` };
    // costSol 0 = 원가 모름(체인 편입) — 첫 마킹이 원가가 된다 (mark 참조). 가짜 원가 1e-6 을 적으면 손익이 400만% 로 나온다 (실측)
    const price = p.costSol > 0 ? p.costSol / p.tokens : 0;
    const markSol = p.pool === "pump" && p.curve && p.curve.vSol > 0 ? liquidationValue(p.curve, p.tokens, CURVE_FEE_PCT) : p.tokens * price * (1 - (this.costs.ammImpactPct + AMM_FEE_PCT) / 100);
    const lot: Lot = { id: `L${++this.seq}`, mint: p.mint, symbol: p.symbol, via: p.via, tokens: p.tokens, costSol: p.costSol, openedAt: ts, pool: p.pool, bondingCurveKey: p.bondingCurveKey, markSol, markAt: ts, peakMarkSol: markSol, curve: p.pool === "pump" ? p.curve : null, lastPrice: price };
    this.lots.set(lot.id, lot);
    const order: PaperOrder = { id: `O${this.seq}`, ts, lotId: lot.id, mint: p.mint, symbol: p.symbol, side: "buy", tokens: p.tokens, sol: p.costSol, feeSol: 0, priorityFeeSol: 0, impactPct: 0, slipPct: 0, pool: p.pool, via: p.via, reason: p.reason, signature: p.signature };
    this.orders.push(order); if (this.orders.length > 5000) this.orders.splice(0, this.orders.length - 5000);
    return { lot, order };
  }

  /** 실체결로 로트(의 일부)를 닫는다 — 받은 SOL은 체인이 말한 값 */
  closeFromFill(lotId: string, tokensSold: number, solReceived: number, reason: string, signature: string, ts = new Date().toISOString()): { order: PaperOrder; closed: boolean } | { error: string } {
    const lot = this.lots.get(lotId);
    if (!lot) return { error: `no lot ${lotId}` };
    const tokens = Math.min(lot.tokens, Math.max(0, tokensSold));
    if (!(tokens > 0)) return { error: "fill sold no tokens" };
    const costPart = lot.costSol * (tokens / lot.tokens);
    const pnl = solReceived - costPart;
    lot.tokens -= tokens; lot.costSol -= costPart;
    const closed = lot.tokens <= 1e-9 || lot.tokens / (lot.tokens + tokens) < 0.01;
    if (closed) this.lots.delete(lot.id); else { lot.markSol = lot.curve ? liquidationValue(lot.curve, lot.tokens, CURVE_FEE_PCT) : lot.tokens * lot.lastPrice * (1 - (this.costs.ammImpactPct + AMM_FEE_PCT) / 100); lot.markAt = ts; }
    const order: PaperOrder = { id: `O${++this.seq}`, ts, lotId: lot.id, mint: lot.mint, symbol: lot.symbol, side: "sell", tokens, sol: solReceived, feeSol: 0, priorityFeeSol: 0, impactPct: 0, slipPct: 0, pool: lot.pool, via: lot.via, reason, pnlSol: +pnl.toFixed(6), pnlPct: costPart > 0 ? +((pnl / costPart) * 100).toFixed(2) : 0, holdMin: +((Date.parse(ts) - Date.parse(lot.openedAt)) / 60_000).toFixed(1), signature };
    this.orders.push(order); if (this.orders.length > 5000) this.orders.splice(0, this.orders.length - 5000);
    return { order, closed };
  }

  /** 시세 마킹 — 커브 상태(정확) 또는 가격(AMM). 원가를 모른 채 편입된 로트(costSol 0)는 첫 마킹이 원가가 된다 */
  mark(mint: string, m: { curve?: CurveState | null; price?: number; pool?: string }, ts = new Date().toISOString()) {
    for (const lot of this.lots.values()) {
      if (lot.mint !== mint) continue;
      const costUnknown = !(lot.costSol > 0);
      if (m.pool && m.pool !== lot.pool) { lot.pool = m.pool; if (m.pool !== "pump") lot.curve = null; } // 졸업: 커브 → AMM
      if (lot.pool === "pump" && m.curve && m.curve.vSol > 0) { lot.curve = m.curve; lot.markSol = liquidationValue(m.curve, lot.tokens, CURVE_FEE_PCT); lot.lastPrice = m.curve.vSol / m.curve.vTokens; }
      else if (m.price && m.price > 0) { lot.lastPrice = m.price; lot.markSol = lot.tokens * m.price * (1 - (this.costs.ammImpactPct + AMM_FEE_PCT) / 100); }
      else continue;
      lot.markAt = ts;
      if (costUnknown && lot.markSol > 0) { lot.costSol = lot.markSol; lot.peakMarkSol = lot.markSol; lot.openedAt = ts; }
      lot.peakMarkSol = Math.max(lot.peakMarkSol, lot.markSol);
      const t = Date.parse(ts) || Date.now(); const h = lot.marks ?? []; h.push({ ts: t, markSol: lot.markSol }); while (h.length && t - h[0].ts > 10 * 60_000) h.shift(); if (h.length > 60) h.splice(0, h.length - 60); lot.marks = h;
    }
  }
}
