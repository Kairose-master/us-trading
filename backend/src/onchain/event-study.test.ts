import { describe, expect, it } from "vitest";
import { eventStudyStats, priceEvents, type DisclosedEvent } from "./event-study.js";

const prices: Record<string, Record<string, number>> = {
  "KRW-X": { "2026-01-01": 100, "2026-01-05": 90, "2026-01-10": 200, "2026-01-15": 180 },
  "KRW-BTC": { "2026-01-01": 1000, "2026-01-05": 1010, "2026-01-10": 1000, "2026-01-15": 1050 },
};
const price = (m: string, iso: string) => prices[m]?.[iso.slice(0, 10)] ?? null;

describe("priceEvents", () => {
  it("computes token vs benchmark return over the announce-to-eta window", () => {
    const ev: DisclosedEvent[] = [{ market: "KRW-X", key: "0x1", impact: "upgrade", announceIso: "2026-01-01T00:00:00Z", etaIso: "2026-01-05T00:00:00Z" }];
    const [p] = priceEvents(ev, price, "KRW-BTC");
    expect(p.tokenReturnPct).toBeCloseTo(-10, 5); // 100 -> 90
    expect(p.benchReturnPct).toBeCloseTo(1, 5); // 1000 -> 1010
    expect(p.spreadPct).toBeCloseTo(-11, 5);
    expect(p.days).toBeCloseTo(4, 1);
  });
  it("drops an event when eta is not after announce (bad data, not invented)", () => {
    const ev: DisclosedEvent[] = [{ market: "KRW-X", key: "0x1", impact: "upgrade", announceIso: "2026-01-05T00:00:00Z", etaIso: "2026-01-01T00:00:00Z" }];
    expect(priceEvents(ev, price, "KRW-BTC")).toHaveLength(0);
  });
  it("drops an event when any leg of price is missing rather than filling a zero", () => {
    const ev: DisclosedEvent[] = [{ market: "KRW-X", key: "0x1", impact: "upgrade", announceIso: "2026-01-01T00:00:00Z", etaIso: "2026-02-01T00:00:00Z" }]; // no Feb price
    expect(priceEvents(ev, price, "KRW-BTC")).toHaveLength(0);
  });
  it("keeps only events with priced legs, in order, and computes each independently", () => {
    const ev: DisclosedEvent[] = [
      { market: "KRW-X", key: "0x1", impact: "supply", announceIso: "2026-01-05T00:00:00Z", etaIso: "2026-01-10T00:00:00Z" },
      { market: "KRW-X", key: "0x2", impact: "upgrade", announceIso: "2026-01-10T00:00:00Z", etaIso: "2026-01-15T00:00:00Z" },
    ];
    const priced = priceEvents(ev, price, "KRW-BTC");
    expect(priced).toHaveLength(2);
    expect(priced[0].tokenReturnPct).toBeCloseTo((200 / 90 - 1) * 100, 5);
    expect(priced[1].tokenReturnPct).toBeCloseTo((180 / 200 - 1) * 100, 5);
  });
});

describe("eventStudyStats", () => {
  it("reports nothing measured rather than a fabricated stat on zero events", () => {
    const r = eventStudyStats([]);
    expect(r.n).toBe(0);
    expect(r.meanSpreadPct).toBeNull();
    expect(r.bootstrapP).toBeNull();
    expect(r.reliable).toBe(false);
  });
  it("computes mean/median spread and a bootstrap p-value from priced events", () => {
    const priced = [
      { market: "KRW-X", key: "0x1", impact: "supply", announceIso: "a", etaIso: "b", tokenReturnPct: -10, benchReturnPct: 2, spreadPct: -12, days: 3 },
      { market: "KRW-X", key: "0x2", impact: "supply", announceIso: "a", etaIso: "b", tokenReturnPct: -8, benchReturnPct: 1, spreadPct: -9, days: 3 },
    ];
    const r = eventStudyStats(priced, { seed: 1, iters: 2000 });
    expect(r.n).toBe(2);
    expect(r.meanSpreadPct).toBeCloseTo(-10.5, 5);
    expect(r.medianSpreadPct).toBeCloseTo(-10.5, 5);
    expect(r.bootstrapP).toBeGreaterThan(0);
    expect(r.bootstrapP).toBeLessThanOrEqual(1);
  });
  it("flags a small sample as unreliable without hiding the number", () => {
    const priced = [{ market: "KRW-X", key: "0x1", impact: "supply", announceIso: "a", etaIso: "b", tokenReturnPct: -10, benchReturnPct: 0, spreadPct: -10, days: 3 }];
    const r = eventStudyStats(priced, { minReliableN: 20 });
    expect(r.n).toBe(1);
    expect(r.meanSpreadPct).toBe(-10);
    expect(r.reliable).toBe(false);
    expect(r.note).toMatch(/사건 1개뿐이다/);
  });
  it("marks a large-enough sample reliable and gives a plain-language note", () => {
    const priced = Array.from({ length: 25 }, (_, i) => ({ market: "KRW-X", key: `0x${i}`, impact: "supply", announceIso: "a", etaIso: "b", tokenReturnPct: -5, benchReturnPct: 0, spreadPct: -5, days: 3 }));
    const r = eventStudyStats(priced, { minReliableN: 20 });
    expect(r.n).toBe(25);
    expect(r.reliable).toBe(true);
    expect(r.note).toMatch(/사건 25개/);
  });
  it("is deterministic for a fixed seed", () => {
    const priced = [
      { market: "KRW-X", key: "0x1", impact: "supply", announceIso: "a", etaIso: "b", tokenReturnPct: -3, benchReturnPct: 1, spreadPct: -4, days: 2 },
      { market: "KRW-X", key: "0x2", impact: "supply", announceIso: "a", etaIso: "b", tokenReturnPct: 2, benchReturnPct: -1, spreadPct: 3, days: 2 },
      { market: "KRW-X", key: "0x3", impact: "supply", announceIso: "a", etaIso: "b", tokenReturnPct: -6, benchReturnPct: 0, spreadPct: -6, days: 2 },
    ];
    const a = eventStudyStats(priced, { seed: 7, iters: 1000 });
    const b = eventStudyStats(priced, { seed: 7, iters: 1000 });
    expect(a.bootstrapP).toBe(b.bootstrapP);
  });
});
