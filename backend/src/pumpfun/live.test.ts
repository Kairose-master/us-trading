import { describe, expect, it } from "vitest";
import { liveBuySize, DEFAULT_LIVE_POLICY as P } from "./live.js";
import { parseTxDeltas, type ParsedTx } from "./solana-rpc.js";
import { PumpLedger } from "./ledger.js";

describe("liveBuySize", () => {
  it("caps by position, gross and wallet reserve, and refuses when the book is full", () => {
    expect(liveBuySize(P, 0.3, 2.5, 0, 0)).toEqual({ sol: 0.1, why: null });
    expect(liveBuySize(P, 0.3, 2.5, 0.95, 2).sol).toBeCloseTo(0.05);
    expect(liveBuySize(P, 0.3, 0.04, 0, 0).sol).toBe(0);
    expect(liveBuySize(P, 0.3, 2.5, 0, 5).why).toMatch(/maxLots/);
  });
});

const tx = (over: Partial<ParsedTx["meta"] & object> = {}, err: unknown = null): ParsedTx => ({
  slot: 1, blockTime: 1_790_000_000,
  transaction: { message: { accountKeys: [{ pubkey: "ME" }, { pubkey: "OTHER" }] } },
  meta: { err, fee: 5000, preBalances: [2_500_000_000, 0], postBalances: [2_398_000_000, 0], preTokenBalances: [], postTokenBalances: [{ accountIndex: 2, mint: "M", owner: "ME", uiTokenAmount: { uiAmount: 123456.7 } }], ...over },
});

describe("parseTxDeltas", () => {
  it("reads our SOL and token deltas from balances, not from estimates", () => {
    const d = parseTxDeltas(tx(), "ME", "M");
    expect(d.ok).toBe(true); expect(d.solDelta).toBeCloseTo(-0.102, 9); expect(d.tokenDelta).toBeCloseTo(123456.7); expect(d.feeSol).toBe(0.000005);
  });
  it("flags a failed transaction and ignores other owners' token accounts", () => {
    const d = parseTxDeltas(tx({ postTokenBalances: [{ accountIndex: 2, mint: "M", owner: "OTHER", uiTokenAmount: { uiAmount: 5 } }] }, { InstructionError: [2, "Custom"] }), "ME", "M");
    expect(d.ok).toBe(false); expect(d.err).toMatch(/InstructionError/); expect(d.tokenDelta).toBe(0);
  });
});

describe("ledger fills from chain", () => {
  it("opens and closes lots with chain-reported amounts and records the signature", () => {
    const l = new PumpLedger(0);
    const r = l.openFromFill({ mint: "M", symbol: "M", pool: "pump", bondingCurveKey: "b", curve: { vSol: 40, vTokens: 8e8 }, tokens: 100_000, costSol: 0.102, via: "W", reason: "copy", signature: "sig1" });
    if (!("lot" in r)) throw new Error(r.error);
    expect(r.order.signature).toBe("sig1"); expect(l.cashSol).toBe(0); // 실장부 현금은 지갑 동기화가 정한다
    const c = l.closeFromFill(r.lot.id, 100_000, 0.15, "leader sold", "sig2");
    if (!("order" in c)) throw new Error(c.error);
    expect(c.closed).toBe(true); expect(c.order.pnlSol).toBeCloseTo(0.048); expect(c.order.signature).toBe("sig2");
    expect(l.lots.size).toBe(0);
  });
});
