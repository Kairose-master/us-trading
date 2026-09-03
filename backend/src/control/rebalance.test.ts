import { describe, expect, it } from "vitest";
import { capTurnover, turnoverPct } from "./rebalance.js";

describe("rebalance", () => {
  it("turnover is half the absolute weight change", () => {
    expect(turnoverPct([{ market: "A", weightPct: 50 }], [{ market: "B", weightPct: 50 }])).toBe(50);
    expect(turnoverPct([{ market: "A", weightPct: 50 }], [{ market: "A", weightPct: 30 }])).toBe(10);
    expect(turnoverPct([], [])).toBe(0);
  });
  it("leaves a small move untouched", () => {
    const r = capTurnover([{ market: "A", weightPct: 20 }], [{ market: "A", weightPct: 30 }], 25);
    expect(r.capped).toBe(false);
    expect(r.targets).toEqual([{ market: "A", weightPct: 30 }]);
    expect(r.note).toBeNull();
  });
  it("moves only maxTurnoverPct of the way toward the target and drops dust", () => {
    const r = capTurnover([{ market: "A", weightPct: 50 }], [{ market: "B", weightPct: 50 }], 25);
    expect(r.capped).toBe(true);
    expect(r.turnoverPct).toBe(50);
    expect(r.targets).toEqual(expect.arrayContaining([{ market: "A", weightPct: 25 }, { market: "B", weightPct: 25 }]));
    expect(turnoverPct([{ market: "A", weightPct: 50 }], r.targets)).toBe(25);
    const tiny = capTurnover([{ market: "A", weightPct: 100 }], [{ market: "B", weightPct: 0.8 }], 1);
    expect(tiny.targets.find((t) => t.market === "B")).toBeUndefined(); // 0.008 < 0.5 dust
  });
});
