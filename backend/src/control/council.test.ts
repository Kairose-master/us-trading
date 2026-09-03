import { describe, expect, it } from "vitest";
import { convene, type CouncilProposal, type ManagerStanding, type RiskContext, type SentimentRead } from "./council.js";

const standing = (w: Partial<Record<"office" | "evolution" | "signals", number>> = {}, off: string[] = []): ManagerStanding[] =>
  (["office", "evolution", "signals", "sentiment", "risk"] as const).map((id) => ({ id, name: id, nameKo: id, weight: (w as Record<string, number>)[id] ?? 1, enabled: !off.includes(id) }));
const risk = (over: Partial<RiskContext> = {}): RiskContext => ({ killSwitch: false, drawdownPct: 0, policy: { maxWeightPct: 30, maxPositions: 8, cashFloorPct: 10, grossMaxPct: 90 }, holdings: [], ...over });
const prop = (manager: CouncilProposal["manager"], targets: Record<string, number>, confidence = 0.8): CouncilProposal => ({ manager, targets: Object.entries(targets).map(([market, weightPct]) => ({ market, weightPct })), confidence, evidence: `${manager} evidence`, ageMin: 1 });
const bearish = (market: string): SentimentRead => ({ market, score: -0.6, label: "BEARISH", mentions: 5, driver: "bad news" });
const bullish = (market: string): SentimentRead => ({ market, score: 0.6, label: "BULLISH", mentions: 5, driver: null });
const out = (r: ReturnType<typeof convene>, m: string) => r.tally.find((t) => t.market === m)!;

describe("council — quorum", () => {
  it("one proposer alone is rejected; nothing is bought", () => {
    const r = convene({ proposals: [prop("evolution", { "KRW-BTC": 25 })], standing: standing(), sentiment: [], risk: risk() });
    expect(r.targets).toEqual([]);
    expect(out(r, "KRW-BTC").outcome).toBe("REJECTED");
    expect(r.quorumMet).toBe(false);
    expect(r.cashPct).toBe(100);
  });
  it("signals alone can never buy, even with sentiment support", () => {
    const r = convene({ proposals: [prop("signals", { "KRW-SOL": 20 }, 1)], standing: standing(), sentiment: [bullish("KRW-SOL")], risk: risk() });
    expect(out(r, "KRW-SOL").outcome).toBe("REJECTED");
    expect(out(r, "KRW-SOL").why).toMatch(/signals alone/);
  });
  it("two distinct proposers adopt; weight is the standing-weighted mean × agreement", () => {
    const r = convene({ proposals: [prop("evolution", { "KRW-BTC": 20 }), prop("office", { "KRW-BTC": 30 })], standing: standing(), sentiment: [], risk: risk() });
    const t = out(r, "KRW-BTC");
    expect(t.outcome).toBe("ADOPTED");
    expect(t.supporters.sort()).toEqual(["evolution", "office"]);
    expect(t.weightPct).toBe(25); // mean 25 × (0.6 + 0.4 × 2/2)
    expect(r.targets).toEqual([{ market: "KRW-BTC", weightPct: 25 }]);
  });
  it("sentiment support tilts +10% but does not count toward quorum", () => {
    const solo = convene({ proposals: [prop("evolution", { "KRW-BTC": 20 })], standing: standing(), sentiment: [bullish("KRW-BTC")], risk: risk() });
    expect(out(solo, "KRW-BTC").outcome).toBe("REJECTED");
    const pair = convene({ proposals: [prop("evolution", { "KRW-BTC": 20 }), prop("office", { "KRW-BTC": 20 })], standing: standing(), sentiment: [bullish("KRW-BTC")], risk: risk() });
    expect(out(pair, "KRW-BTC").weightPct).toBe(22);
  });
  it("a bearish objection halves a co-supported market and withdraws a lone one", () => {
    const r = convene({ proposals: [prop("evolution", { "KRW-BTC": 20, "KRW-ETH": 20 }), prop("office", { "KRW-BTC": 20 })], standing: standing(), sentiment: [bearish("KRW-BTC"), bearish("KRW-ETH")], risk: risk() });
    expect(out(r, "KRW-ETH").outcome).toBe("WITHDRAWN");
    const btc = out(r, "KRW-BTC");
    expect(btc.outcome).toBe("ADOPTED");
    expect(btc.weightPct).toBe(10); // halved to 10 each → mean 10 × 1.0
    expect(btc.opposers).toEqual(["sentiment"]);
  });
  it("hysteresis: a held market survives on one supporter, capped at 1.25× current weight", () => {
    const held = risk({ holdings: [{ market: "KRW-SOL", weightPct: 10 }] });
    const r = convene({ proposals: [prop("evolution", { "KRW-SOL": 30 })], standing: standing(), sentiment: [], risk: held });
    const t = out(r, "KRW-SOL");
    expect(t.outcome).toBe("ADOPTED");
    expect(t.weightPct).toBe(12.5);
    expect(t.why).toMatch(/held position kept/);
  });
  it("hysteresis does not apply to a market nobody holds or one that is opposed", () => {
    const held = risk({ holdings: [{ market: "KRW-SOL", weightPct: 10 }] });
    const opposed = convene({ proposals: [prop("evolution", { "KRW-SOL": 30 })], standing: standing(), sentiment: [bearish("KRW-SOL")], risk: held });
    expect(out(opposed, "KRW-SOL").outcome).toBe("WITHDRAWN");
    const notHeld = convene({ proposals: [prop("evolution", { "KRW-ETH": 30 })], standing: standing(), sentiment: [], risk: held });
    expect(out(notHeld, "KRW-ETH").outcome).toBe("REJECTED");
  });
  it("a disabled manager's proposal is ignored", () => {
    const r = convene({ proposals: [prop("evolution", { "KRW-BTC": 20 }), prop("office", { "KRW-BTC": 20 })], standing: standing({}, ["office"]), sentiment: [], risk: risk() });
    expect(out(r, "KRW-BTC").outcome).toBe("REJECTED");
  });
});

describe("council — risk manager", () => {
  const pair = [prop("evolution", { "KRW-BTC": 30, "KRW-ETH": 30 }), prop("office", { "KRW-BTC": 30, "KRW-ETH": 30 })];
  it("kill switch vetoes every market", () => {
    const r = convene({ proposals: pair, standing: standing(), sentiment: [], risk: risk({ killSwitch: true }) });
    expect(r.targets).toEqual([]);
    expect(r.tally.every((t) => t.vetoed && t.outcome === "REJECTED")).toBe(true);
  });
  it("drawdown ≥ 15% vetoes; ≥ 8% halves gross exposure", () => {
    const veto = convene({ proposals: pair, standing: standing(), sentiment: [], risk: risk({ drawdownPct: 15 }) });
    expect(veto.targets).toEqual([]);
    const half = convene({ proposals: pair, standing: standing(), sentiment: [], risk: risk({ drawdownPct: 8 }) });
    const gross = half.targets.reduce((a, t) => a + t.weightPct, 0);
    expect(gross).toBeCloseTo(45, 0); // min(90, 100-10)=90 → 45
    expect(half.constraints.some((c) => /gross/.test(c))).toBe(true);
  });
  it("policy caps per-market weight, position count and gross", () => {
    const many = Object.fromEntries(["A", "B", "C", "D"].map((s) => [`KRW-${s}`, 40]));
    const r = convene({ proposals: [prop("evolution", many), prop("office", many)], standing: standing(), sentiment: [], risk: risk({ policy: { maxWeightPct: 30, maxPositions: 3, cashFloorPct: 20, grossMaxPct: 90 } }) });
    expect(r.targets.length).toBe(3);
    expect(Math.max(...r.targets.map((t) => t.weightPct))).toBeLessThanOrEqual(30);
    expect(r.targets.reduce((a, t) => a + t.weightPct, 0)).toBeCloseTo(80, 0);
    expect(r.cashPct).toBeCloseTo(20, 0);
  });
});

describe("council — weighted (proportional)", () => {
  it("at cold start (all standings 1) it decides like quorum: one proposer cannot buy, two can", () => {
    const solo = convene({ proposals: [prop("evolution", { "KRW-BTC": 25 }, 1)], standing: standing(), sentiment: [], risk: risk(), mode: "weighted" });
    expect(out(solo, "KRW-BTC").outcome).toBe("REJECTED");
    expect(out(solo, "KRW-BTC").why).toMatch(/conviction 0\.33/);
    const pair = convene({ proposals: [prop("evolution", { "KRW-BTC": 20 }, 0.5), prop("office", { "KRW-BTC": 20 }, 0.5)], standing: standing(), sentiment: [], risk: risk(), mode: "weighted" });
    expect(out(pair, "KRW-BTC").outcome).toBe("ADOPTED");
    expect(out(pair, "KRW-BTC").why).toMatch(/conviction 0\.50/);
  });
  it("a high-standing manager buys alone; the silence of others still counts in the denominator", () => {
    const r = convene({ proposals: [prop("office", { "KRW-XRP": 20 }, 0.9)], standing: standing({ office: 3 }), sentiment: [], risk: risk(), mode: "weighted" });
    const t = out(r, "KRW-XRP");
    expect(t.outcome).toBe("ADOPTED"); // 3/5 × 0.95 = 0.57
    expect(t.weightPct).toBe(20);
    const low = convene({ proposals: [prop("office", { "KRW-XRP": 20 }, 0.9)], standing: standing({ office: 3, evolution: 5, signals: 5 }), sentiment: [], risk: risk(), mode: "weighted" });
    expect(out(low, "KRW-XRP").outcome).toBe("REJECTED"); // 3/13 × 0.95 = 0.22
  });
  it("signals alone is barred in weighted mode too, whatever its standing", () => {
    const r = convene({ proposals: [prop("signals", { "KRW-SOL": 20 }, 1)], standing: standing({ signals: 5 }), sentiment: [], risk: risk(), mode: "weighted" });
    expect(out(r, "KRW-SOL").outcome).toBe("REJECTED");
  });
  it("conviction below the threshold keeps a held market (hysteresis) but not a new one", () => {
    const held = risk({ holdings: [{ market: "KRW-SOL", weightPct: 10 }] });
    const r = convene({ proposals: [prop("evolution", { "KRW-SOL": 30, "KRW-ETH": 30 }, 0.5)], standing: standing(), sentiment: [], risk: held, mode: "weighted" });
    expect(out(r, "KRW-SOL").outcome).toBe("ADOPTED");
    expect(out(r, "KRW-SOL").weightPct).toBeLessThanOrEqual(12.5);
    expect(out(r, "KRW-ETH").outcome).toBe("REJECTED");
  });
  it("convictionMin is honoured and the result names its mode", () => {
    const strict = convene({ proposals: [prop("evolution", { "KRW-BTC": 20 }, 0.5), prop("office", { "KRW-BTC": 20 }, 0.5)], standing: standing(), sentiment: [], risk: risk(), mode: "weighted", convictionMin: 0.6 });
    expect(out(strict, "KRW-BTC").outcome).toBe("REJECTED");
    expect(strict.mode).toBe("weighted");
    expect(strict.summary[0]).toMatch(/비례제/);
  });
});
