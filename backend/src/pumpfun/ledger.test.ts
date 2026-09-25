import { describe, expect, it } from "vitest";
import { PumpLedger } from "./ledger.js";
import { INITIAL_V_SOL, INITIAL_V_TOKENS } from "./curve.js";

const curve = { vSol: INITIAL_V_SOL + 5, vTokens: (INITIAL_V_SOL * INITIAL_V_TOKENS) / (INITIAL_V_SOL + 5), rTokens: 700_000_000, rSol: 5 };

describe("PumpLedger", () => {
  it("buys on the curve with fee + latency slip + priority fee, marks at liquidation value, and a round trip loses the costs", () => {
    const l = new PumpLedger(10, { latencySlipPct: 0.5, ammImpactPct: 1, priorityFeeSol: 0.001 });
    const r = l.buy({ mint: "m", symbol: "M", pool: "pump", bondingCurveKey: "b", curve, price: 0, solIn: 1, via: "W", reason: "test" });
    expect("lot" in r).toBe(true); if (!("lot" in r)) return;
    expect(l.cashSol).toBeCloseTo(8.999, 6);
    expect(r.lot.markSol).toBeLessThan(1); // 사자마자 평가액은 비용만큼 아래
    expect(r.lot.markSol).toBeGreaterThan(0.95);
    const s = l.sell(r.lot.id, 1, "exit");
    expect("order" in s && s.closed).toBe(true); if (!("order" in s)) return;
    expect(s.order.pnlSol!).toBeLessThan(0);
    expect(s.order.pnlSol!).toBeGreaterThan(-0.06);
    expect(l.lots.size).toBe(0);
    expect(l.equitySol()).toBeCloseTo(l.cashSol, 12);
  });
  it("refuses to spend more than cash and rejects AMM fills without a price", () => {
    const l = new PumpLedger(0.5);
    expect(l.buy({ mint: "m", symbol: "M", pool: "pump", bondingCurveKey: "b", curve, price: 0, solIn: 1, via: "W", reason: "t" })).toHaveProperty("error");
    expect(l.buy({ mint: "m", symbol: "M", pool: "pump-amm", bondingCurveKey: null, curve: null, price: 0, solIn: 0.1, via: "W", reason: "t" })).toHaveProperty("error");
  });
  it("partial sells keep the remainder and a pump marks the lot up", () => {
    const l = new PumpLedger(10);
    const r = l.buy({ mint: "m", symbol: "M", pool: "pump", bondingCurveKey: "b", curve, price: 0, solIn: 1, via: "W", reason: "t" });
    if (!("lot" in r)) throw new Error("buy failed");
    const tokens0 = r.lot.tokens;
    const pumped = { ...r.lot.curve!, vSol: r.lot.curve!.vSol * 2, vTokens: r.lot.curve!.vTokens / 2 };
    l.mark("m", { curve: pumped });
    expect(l.lots.get(r.lot.id)!.markSol).toBeGreaterThan(3);
    const s = l.sell(r.lot.id, 0.5, "half");
    if (!("order" in s)) throw new Error("sell failed");
    expect(s.closed).toBe(false);
    expect(s.order.pnlSol!).toBeGreaterThan(1);
    expect(l.lots.get(r.lot.id)!.tokens).toBeCloseTo(tokens0 / 2, 6);
  });
  it("AMM fills use observed price with assumed impact and survive snapshot/restore", () => {
    const l = new PumpLedger(10);
    const r = l.buy({ mint: "m", symbol: "M", pool: "pump-amm", bondingCurveKey: null, curve: null, price: 0.0001, solIn: 1, via: "W", reason: "t" });
    if (!("lot" in r)) throw new Error("buy failed");
    expect(r.lot.tokens).toBeLessThan(10_000);
    const l2 = PumpLedger.restore(l.snapshot(), l.costs);
    expect(l2.equitySol()).toBeCloseTo(l.equitySol(), 12);
    l2.mark("m", { price: 0.0002 });
    expect(l2.lots.get(r.lot.id)!.markSol).toBeGreaterThan(1.9);
  });
});
