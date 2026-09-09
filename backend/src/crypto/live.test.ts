import { describe, expect, it } from "vitest";
import { planRotation, toLiveAccount, liveEquityKrw, MIN_ORDER_KRW } from "./live.js";

const acct = (cashKrw: number, pos: Record<string, [number, number]>, locked: Record<string, number> = {}) => ({
  cashKrw, lockedKrw: 0, syncedAt: "t",
  positions: new Map(Object.entries(pos).map(([s, [qty, avg]]) => [s, { qty, avgKrw: avg, lockedQty: locked[s] ?? 0 }])),
});
const prices = new Map([["KRW-BTC", 100_000_000], ["KRW-ETH", 5_000_000], ["KRW-SOL", 200_000]]);

describe("toLiveAccount", () => {
  it("maps KRW cash and coin positions, dropping zero balances and non-KRW units", () => {
    const a = toLiveAccount([
      { currency: "KRW", balance: "1000000", locked: "50000", avg_buy_price: "0", unit_currency: "KRW" },
      { currency: "BTC", balance: "0.01", locked: "0.002", avg_buy_price: "90000000", unit_currency: "KRW" },
      { currency: "DOGE", balance: "0", locked: "0", avg_buy_price: "0", unit_currency: "KRW" },
      { currency: "XRP", balance: "10", locked: "0", avg_buy_price: "1", unit_currency: "BTC" },
    ]);
    expect(a.cashKrw).toBe(1_000_000); expect(a.lockedKrw).toBe(50_000);
    expect([...a.positions.keys()]).toEqual(["BTC"]);
    expect(a.positions.get("BTC")).toEqual({ qty: 0.012, lockedQty: 0.002, avgKrw: 90_000_000 });
    expect(liveEquityKrw(a, (m) => prices.get(m) ?? 0)).toBeCloseTo(1_050_000 + 0.012 * 100_000_000);
  });
});

describe("planRotation", () => {
  it("sells holdings outside the target set, then buys toward target weights", () => {
    const r = planRotation({ account: acct(1_000_000, { SOL: [5, 150_000] }), prices, targets: [{ market: "KRW-BTC", weightPct: 50 }], maxOrderKrw: 5_000_000 });
    // equity = 1,000,000 + 5*200,000 = 2,000,000 → BTC target 1,000,000
    expect(r.equityKrw).toBe(2_000_000);
    expect(r.orders.map((o) => [o.market, o.side])).toEqual([["KRW-SOL", "sell"], ["KRW-BTC", "buy"]]);
    expect(r.orders[0].volume).toBe(5);
    expect(r.orders[1].amountKrw).toBe(1_000_000);
  });
  it("ignores diffs under the exchange minimum and dust positions", () => {
    const r = planRotation({ account: acct(10_000, { BTC: [0.00001, 1] }), prices, targets: [{ market: "KRW-ETH", weightPct: 30 }], maxOrderKrw: 5_000_000 });
    // BTC dust (₩1,000) stays; ETH target 30% of ~11,000 = ₩3,300 < 5,000 → nothing
    expect(r.orders).toEqual([]);
    expect(r.skipped.some((s) => s.includes("먼지"))).toBe(true);
  });
  it("clamps each buy to maxOrderKrw and to available cash after fees", () => {
    const r = planRotation({ account: acct(300_000, {}), prices, targets: [{ market: "KRW-BTC", weightPct: 90 }, { market: "KRW-ETH", weightPct: 10 }], maxOrderKrw: 200_000 });
    const btc = r.orders.find((o) => o.market === "KRW-BTC")!, eth = r.orders.find((o) => o.market === "KRW-ETH")!;
    expect(btc.amountKrw).toBe(200_000);
    expect(btc.note).toContain("상한");
    expect(eth.amountKrw).toBeLessThanOrEqual(30_000);
    expect(btc.amountKrw * 1.0005 + eth.amountKrw * 1.0005).toBeLessThanOrEqual(300_000 + 1);
  });
  it("never sells quantity locked in open orders", () => {
    const r = planRotation({ account: acct(0, { SOL: [10, 1] }, { SOL: 4 }), prices, targets: [], maxOrderKrw: 5_000_000 });
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0].volume).toBe(6);
  });
  it("skips buys when no price is known and reports it", () => {
    const r = planRotation({ account: acct(1_000_000, {}), prices, targets: [{ market: "KRW-NOPE", weightPct: 50 }], maxOrderKrw: 5_000_000 });
    expect(r.orders).toEqual([]);
    expect(r.skipped[0]).toContain("현재가 없음");
  });
  it("exposes the minimum order constant used by the desk", () => {
    expect(MIN_ORDER_KRW).toBe(5_000);
  });
});
