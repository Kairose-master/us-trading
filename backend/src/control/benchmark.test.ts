import { describe, expect, it } from "vitest";
import { computeBenchmark, makeBase } from "./benchmark.js";

const since = "2026-09-03T01:36:27.000Z";
const base = makeBase({ since, startEquityKrw: 10_000_000, markets: ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-NOPRICE"], prices: { "KRW-BTC": 100_000_000, "KRW-ETH": 4_000_000, "KRW-SOL": 200_000 }, source: "live" });

describe("benchmark", () => {
  it("drops unpriced markets from the basket and records the BTC base", () => {
    expect(Object.keys(base.basket).sort()).toEqual(["KRW-BTC", "KRW-ETH", "KRW-SOL"]);
    expect(base.btcKrw).toBe(100_000_000);
  });
  it("computes portfolio, BTC-hold, equal-weight and the two alphas", () => {
    const now = Date.parse(since) + 2 * 3_600_000;
    const r = computeBenchmark(base, { "KRW-BTC": 110_000_000, "KRW-ETH": 4_000_000, "KRW-SOL": 180_000 }, 10_200_000, now);
    expect(r.portfolioPct).toBe(2);
    expect(r.btcHoldPct).toBe(10);
    expect(r.ewUniversePct).toBeCloseTo(0, 5); // (+10, 0, -10) / 3
    expect(r.alphaVsBtcPct).toBe(-8);
    expect(r.alphaVsEwPct).toBeCloseTo(2, 5);
    expect(r.hours).toBe(2);
    expect(r.ewCoverage).toEqual({ priced: 3, basket: 3 });
  });
  it("gives no equal-weight number when fewer than half the basket has a price", () => {
    const r = computeBenchmark(base, { "KRW-BTC": 110_000_000 }, 10_000_000);
    expect(r.ewUniversePct).toBeNull(); // 1 priced of 3 < ceil(3/2)=2
    expect(r.alphaVsEwPct).toBeNull();
    expect(r.btcHoldPct).toBe(10);
    expect(r.ewCoverage).toEqual({ priced: 1, basket: 3 });
  });
});
