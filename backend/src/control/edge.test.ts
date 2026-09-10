import { describe, expect, it } from "vitest";
import { edgeGate, updateDrift, type MarketDrift } from "./edge.js";

const series = (pxs: number[], hl = 72) => pxs.reduce<MarketDrift | undefined>((d, px, i) => updateDrift(d, px, `t${i}`, hl), undefined)!;

describe("updateDrift", () => {
  it("tracks the mean per-mark return of a steady uptrend and near-zero variance", () => {
    const d = series(Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1.001, i)));
    expect(d.n).toBe(39);
    expect(d.mean).toBeCloseTo(0.001, 5);
    expect(d.var).toBeLessThan(1e-9);
  });
  it("ignores non-positive prices and starts counting from the first valid price", () => {
    const d0 = updateDrift(undefined, 0, "t0", 72);
    expect(d0.n).toBe(0);
    const d1 = updateDrift(d0, 100, "t1", 72);
    expect(d1.n).toBe(0); expect(d1.lastPx).toBe(100);
    const d2 = updateDrift(d1, 101, "t2", 72);
    expect(d2.n).toBe(1); expect(d2.mean).toBeCloseTo(0.01, 6);
  });
});

describe("edgeGate", () => {
  const up = series(Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1.001, i)));      // +0.1%/mark, no noise
  const flat = series(Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 0.05 : -0.05))); // 횡보 잡음
  const base = { horizonMarks: 12, oneWayCostPct: 0.1, z: 1, minMarks: 6 };

  it("charges one-way cost on every unit of weight moved", () => {
    const r = edgeGate({ ...base, holdings: [{ market: "KRW-BTC", weightPct: 20 }], targets: [{ market: "KRW-ETH", weightPct: 20 }], drift: { "KRW-BTC": up, "KRW-ETH": up } });
    expect(r.costPct).toBeCloseTo(0.4 * 0.1, 6); // 20% 매도 + 20% 매수
  });
  it("passes when moving into a clear uptrend covers the cost", () => {
    const r = edgeGate({ ...base, holdings: [], targets: [{ market: "KRW-BTC", weightPct: 50 }], drift: { "KRW-BTC": up } });
    // 0.5 × 0.1% × 12 = +0.6% expected vs 0.05% cost
    expect(r.expectedPct).toBeCloseTo(0.6, 2);
    expect(r.pass).toBe(true);
  });
  it("skips a rebalance in a flat, noisy market", () => {
    const r = edgeGate({ ...base, holdings: [{ market: "KRW-BTC", weightPct: 30 }], targets: [{ market: "KRW-ETH", weightPct: 30 }], drift: { "KRW-BTC": flat, "KRW-ETH": flat } });
    expect(r.pass).toBe(false);
    expect(r.why).toContain("not worth");
  });
  it("skips selling a winner into cash — negative expected edge", () => {
    const r = edgeGate({ ...base, holdings: [{ market: "KRW-BTC", weightPct: 40 }], targets: [], drift: { "KRW-BTC": up } });
    expect(r.expectedPct).toBeLessThan(0);
    expect(r.pass).toBe(false);
  });
  it("refuses to judge when most of the turnover has no drift history", () => {
    const r = edgeGate({ ...base, holdings: [], targets: [{ market: "KRW-NEW", weightPct: 30 }, { market: "KRW-BTC", weightPct: 5 }], drift: { "KRW-BTC": up } });
    expect(r.coverage).toBeCloseTo(5 / 35, 2);
    expect(r.pass).toBe(false);
    expect(r.why).toContain("drift history");
  });
  it("a higher z demands more evidence", () => {
    const noisyUp = series(Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.0004, i) * (1 + (i % 2 ? 0.002 : -0.002))));
    const lo = edgeGate({ ...base, z: 0.5, holdings: [], targets: [{ market: "KRW-BTC", weightPct: 50 }], drift: { "KRW-BTC": noisyUp } });
    const hi = edgeGate({ ...base, z: 3, holdings: [], targets: [{ market: "KRW-BTC", weightPct: 50 }], drift: { "KRW-BTC": noisyUp } });
    expect(hi.lowerPct).toBeLessThan(lo.lowerPct);
    expect(lo.pass || !hi.pass).toBe(true);
  });
});
