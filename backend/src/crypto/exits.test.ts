import { describe, expect, it } from "vitest";
import { applyCooldown, DEFAULT_EXIT_RULES, evaluateExits, validateExitRules, type ExitTrack } from "./exits.js";

const T0 = Date.parse("2026-09-12T00:00:00Z");
const H = 3600_000;
const pos = (symbol: string, avgKrw: number, curKrw: number, qty = 1, lockedQty = 0) => ({ symbol, qty, lockedQty, avgKrw, curKrw });
const track = (over: Partial<ExitTrack> = {}): ExitTrack => ({ highKrw: 0, since: new Date(T0).toISOString(), tpTaken: false, unsupportedSince: null, ...over });
const run = (positions: ReturnType<typeof pos>[], tracks = new Map<string, ExitTrack>(), over: Partial<typeof DEFAULT_EXIT_RULES> = {}, supported: Set<string> | null = null, now = T0) =>
  evaluateExits({ positions, tracks, rules: { ...DEFAULT_EXIT_RULES, ...over }, supportedMarkets: supported, now });

describe("evaluateExits", () => {
  it("does nothing while the position sits inside every band, but starts tracking its high", () => {
    const r = run([pos("BTC", 100, 103)]);
    expect(r.actions).toEqual([]);
    expect(r.tracks.get("BTC")).toMatchObject({ highKrw: 103, tpTaken: false, unsupportedSince: null });
  });
  it("stops out the whole position at −7% from average cost", () => {
    const r = run([pos("BTC", 100, 92.9, 2)]);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "stop", sellPct: 100, volume: 2, market: "KRW-BTC", pnlPct: -7.1 });
  });
  it("trails: sells when price falls 10% from the tracked high even if still above cost", () => {
    const r = run([pos("ETH", 100, 108)], new Map([["ETH", track({ highKrw: 120 })]]));
    expect(r.actions[0]).toMatchObject({ kind: "trail", sellPct: 100 });
    expect(r.actions[0].reason).toContain("120");
    expect(r.tracks.get("ETH")!.highKrw).toBe(120);
  });
  it("raises the high as price climbs and does not trail on a shallow dip", () => {
    const r = run([pos("ETH", 100, 125)], new Map([["ETH", track({ highKrw: 120, tpTaken: true })]]));
    expect(r.actions).toEqual([]);
    expect(r.tracks.get("ETH")!.highKrw).toBe(125);
  });
  it("takes profit once: half the position at +20%, then never again for that position", () => {
    const first = run([pos("SOL", 100, 121, 4)]);
    expect(first.actions[0]).toMatchObject({ kind: "take", sellPct: 50, volume: 2 });
    // 데스크가 실행 후 tpTaken을 켠다 — 그 뒤로는 같은 조건에서 다시 팔지 않는다
    const again = run([pos("SOL", 100, 130, 2)], new Map([["SOL", track({ highKrw: 121, tpTaken: true })]]));
    expect(again.actions).toEqual([]);
  });
  it("stop-loss wins over take-profit bookkeeping and trail wins over stale", () => {
    const r = run([pos("A", 100, 80), pos("B", 100, 100)], new Map([["B", track({ highKrw: 200, unsupportedSince: new Date(T0 - 48 * H).toISOString() })]]));
    expect(r.actions.map((a) => [a.symbol, a.kind])).toEqual([["A", "stop"], ["B", "trail"]]);
  });
  it("marks a position unsupported when no manager backs it, and sells after staleHours", () => {
    const supported = new Set(["KRW-BTC"]);
    const t1 = run([pos("XRP", 100, 101)], new Map(), {}, supported, T0);
    expect(t1.actions).toEqual([]);
    expect(t1.tracks.get("XRP")!.unsupportedSince).toBe(new Date(T0).toISOString());
    const t2 = run([pos("XRP", 100, 101)], t1.tracks, {}, supported, T0 + 23 * H);
    expect(t2.actions).toEqual([]);
    const t3 = run([pos("XRP", 100, 101)], t2.tracks, {}, supported, T0 + 24 * H);
    expect(t3.actions[0]).toMatchObject({ kind: "stale", sellPct: 100 });
    // 다시 지지가 생기면 타이머는 풀린다
    const t4 = run([pos("XRP", 100, 101)], t2.tracks, {}, new Set(["KRW-XRP"]), T0 + 24 * H);
    expect(t4.actions).toEqual([]);
    expect(t4.tracks.get("XRP")!.unsupportedSince).toBeNull();
  });
  it("never judges staleness without proposal information", () => {
    const r = run([pos("XRP", 100, 101)], new Map([["XRP", track({ highKrw: 101, unsupportedSince: new Date(T0 - 100 * H).toISOString() })]]), {}, null);
    expect(r.actions).toEqual([]);
  });
  it("sells only the unlocked quantity and skips positions with nothing available", () => {
    const r = run([pos("BTC", 100, 80, 5, 2), pos("ETH", 100, 80, 3, 3)]);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ symbol: "BTC", volume: 3 });
  });
  it("keeps tracking but takes no action when disabled, and drops tracks for symbols no longer held", () => {
    const r = run([pos("BTC", 100, 50)], new Map([["GONE", track({ highKrw: 9 })]]), { enabled: false });
    expect(r.actions).toEqual([]);
    expect([...r.tracks.keys()]).toEqual(["BTC"]);
  });
});

describe("applyCooldown", () => {
  const until = new Date(T0 + H).toISOString();
  it("drops cooling markets from the targets when not held, and pins them at current weight when held", () => {
    const r = applyCooldown([{ market: "KRW-BTC", weightPct: 20 }, { market: "KRW-ETH", weightPct: 10 }], new Map([["BTC", until], ["ETH", until]]), (m) => (m === "KRW-ETH" ? 4.4 : 0), T0);
    expect(r.targets).toEqual([{ market: "KRW-ETH", weightPct: 4.4 }]);
    expect(r.notes).toHaveLength(2);
  });
  it("ignores expired cooldowns", () => {
    const r = applyCooldown([{ market: "KRW-BTC", weightPct: 20 }], new Map([["BTC", until]]), () => 0, T0 + 2 * H);
    expect(r.targets).toEqual([{ market: "KRW-BTC", weightPct: 20 }]);
    expect(r.notes).toEqual([]);
  });
});

describe("validateExitRules", () => {
  it("accepts sane patches and rejects out-of-range or wrong-typed ones", () => {
    expect(validateExitRules({ stopLossPct: 5, enabled: false })).toBeNull();
    expect(validateExitRules({ stopLossPct: 0 })).toContain("stopLossPct");
    expect(validateExitRules({ takeProfitSellPct: 150 })).toContain("takeProfitSellPct");
    expect(validateExitRules({ enabled: "yes" as unknown as boolean })).toContain("enabled");
  });
});
