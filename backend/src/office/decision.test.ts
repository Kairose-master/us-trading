import { describe, expect, it } from "vitest";
import { buildDecision, extractTargets, DEFAULT_GATE } from "./decision.js";

const chair = (targets: Record<string, number>, cashPct: number, confidence?: number) =>
  ["# run", "## Investment committee decision — Chair", "```json", JSON.stringify({ targets: Object.entries(targets).map(([market, weightPct]) => ({ market, weightPct })), cashPct, ...(confidence === undefined ? {} : { confidence }) }), "```"].join("\n");
const status = (n: number) => ["x [completed]", ...Array.from({ length: n }, (_, i) => `  - Completed Step ${i + 1} — ok`)].join("\n");

describe("office decision", () => {
  it("reads the chair's confidence out of the json block", () => {
    expect(extractTargets(chair({ "KRW-BTC": 20 }, 80, 0.29))?.confidence).toBe(0.29);
    expect(extractTargets(chair({ "KRW-BTC": 20 }, 80))?.confidence).toBeUndefined();
    expect(extractTargets(chair({ "KRW-BTC": 20 }, 80, 5))?.confidence).toBeUndefined(); // out of range → ignored
  });
  it("counts only non-zero weights against maxPositions — a zero is 'considered and declined'", () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`KRW-C${i}`, i < 3 ? 10 : 0]));
    const d = buildDecision({ delegationId: "x", output: chair(many, 70, 0.4), statusText: status(9), expectedSteps: 9, gate: { ...DEFAULT_GATE, allowedMarkets: new Set(Object.keys(many)) } });
    expect(d.reasons).toEqual([]);
    expect(d.executable).toBe(true);
    expect(d.confidence).toBe(0.4);
    const over = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`KRW-C${i}`, 9]));
    const d2 = buildDecision({ delegationId: "x", output: chair(over, 10), statusText: status(9), expectedSteps: 9, gate: { ...DEFAULT_GATE, allowedMarkets: new Set(Object.keys(over)) } });
    expect(d2.reasons.some((r) => /포지션 수 10 > 8/.test(r))).toBe(true);
  });
  it("all-zero weights is a valid cash decision, not a parse failure", () => {
    const cash = { "KRW-BTC": 0, "KRW-ETH": 0 };
    const d = buildDecision({ delegationId: "x", output: chair(cash, 100, 0.5), statusText: status(9), expectedSteps: 9, gate: { ...DEFAULT_GATE, allowedMarkets: new Set(Object.keys(cash)) } });
    expect(d.executable).toBe(true);
    expect(d.cashPct).toBe(100);
    expect(d.targets.every((t) => t.weightPct === 0)).toBe(true);
  });
  it("still rejects gross over 100 and out-of-scope markets", () => {
    const bad = { "KRW-BTC": 60, "KRW-ETH": 60 };
    const d = buildDecision({ delegationId: "x", output: chair(bad, -20), statusText: status(9), expectedSteps: 9, gate: { ...DEFAULT_GATE, allowedMarkets: new Set(["KRW-BTC"]) } });
    expect(d.executable).toBe(false);
    expect(d.reasons.some((r) => /스코프 밖/.test(r))).toBe(true);
    expect(d.reasons.some((r) => /비중 합/.test(r))).toBe(true);
  });
});
