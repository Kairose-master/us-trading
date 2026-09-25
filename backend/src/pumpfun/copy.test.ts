import { describe, expect, it } from "vitest";
import { applyOutcome, lotExits, onLeaderTrade, sizeFor, DEFAULT_COPY_POLICY as P } from "./copy.js";
import type { Lot } from "./ledger.js";

const trade = (side: "buy" | "sell", sol = 0.5, tokens = 1000, newBal = 0) => ({ kind: "trade" as const, ts: "t", mint: "m", wallet: "LEADER", side, sol, tokens, newTokenBalance: newBal, vSol: 31, vTokens: 1e9, marketCapSol: 31, pool: "pump", bondingCurveKey: "b", signature: "s" });
const follow = { wallet: "LEADER", standing: 1, since: "t", source: "scored" as const, closes: 0, wins: 0, cumPct: 0, returns: [] };
const lot = (over: Partial<Lot> = {}): Lot => ({ id: "L1", mint: "m", symbol: "M", via: "LEADER", tokens: 1000, costSol: 0.2, openedAt: new Date(Date.now() - 10 * 60_000).toISOString(), pool: "pump", bondingCurveKey: "b", markSol: 0.2, markAt: "t", peakMarkSol: 0.2, curve: null, lastPrice: 0, ...over });
const ctx = (over: Partial<Parameters<typeof onLeaderTrade>[1]> = {}) => ({ policy: P, follow, lots: [] as Lot[], equitySol: 10, cashSol: 10, positionsSol: 0, paused: false, ...over });

describe("onLeaderTrade", () => {
  it("copies a leader buy sized by equity × risk × standing, capped per position", () => {
    const a = onLeaderTrade(trade("buy"), ctx());
    expect(a[0]).toMatchObject({ type: "buy", solIn: 0.2 }); // 10 × 2% × 1.0 = 0.2 < 0.3 cap
    const b = onLeaderTrade(trade("buy"), ctx({ equitySol: 100, cashSol: 100 }));
    expect(b[0]).toMatchObject({ type: "buy", solIn: 0.3 });
    expect(sizeFor(P, 10, 0.5)).toBeCloseTo(0.1);
  });
  it("ignores dust buys, unfollowed wallets, duplicates, pause, and full books", () => {
    expect(onLeaderTrade(trade("buy", 0.01), ctx())[0].type).toBe("skip");
    expect(onLeaderTrade(trade("buy"), ctx({ follow: undefined }))[0].type).toBe("skip");
    expect(onLeaderTrade(trade("buy"), ctx({ lots: [lot()] }))[0].type).toBe("skip");
    expect(onLeaderTrade(trade("buy"), ctx({ paused: true }))[0].type).toBe("skip");
    expect(onLeaderTrade(trade("buy"), ctx({ positionsSol: 6 }))[0].type).toBe("skip"); // gross 60% 다 참
  });
  it("follows a leader sell pro-rata, and all-out when they dump more than half — even when paused", () => {
    const half = onLeaderTrade(trade("sell", 0.1, 300, 700), ctx({ lots: [lot()], paused: true }));
    expect(half[0]).toMatchObject({ type: "sell", lotId: "L1", fraction: 0.3 });
    const dump = onLeaderTrade(trade("sell", 0.1, 800, 200), ctx({ lots: [lot()] }));
    expect(dump[0]).toMatchObject({ type: "sell", fraction: 1 });
  });
});

describe("anti-flip rules", () => {
  it("does not copy a leader who is flipping the token, scalping lately, or a token we just exited", () => {
    expect(onLeaderTrade(trade("buy"), ctx({ recent: { flipsOnMint10m: 2, medianHoldMin30m: 8, ourLastExitMinAgo: null } }))[0]).toMatchObject({ type: "skip", reason: expect.stringMatching(/flipped/) });
    expect(onLeaderTrade(trade("buy"), ctx({ recent: { flipsOnMint10m: 0, medianHoldMin30m: 0.8, ourLastExitMinAgo: null } }))[0]).toMatchObject({ type: "skip", reason: expect.stringMatching(/scalping mode/) });
    expect(onLeaderTrade(trade("buy"), ctx({ recent: { flipsOnMint10m: 0, medianHoldMin30m: 8, ourLastExitMinAgo: 4 } }))[0]).toMatchObject({ type: "skip", reason: expect.stringMatching(/cooldown/) });
    expect(onLeaderTrade(trade("buy"), ctx({ recent: { flipsOnMint10m: 0, medianHoldMin30m: 8, ourLastExitMinAgo: 40 } }))[0].type).toBe("buy");
    expect(onLeaderTrade(trade("buy"), ctx({ recent: { flipsOnMint10m: 0, medianHoldMin30m: null, ourLastExitMinAgo: null } }))[0].type).toBe("buy");
  });
});

describe("lotExits", () => {
  it("stop-loss, trailing from a real peak, and time stop", () => {
    const sl = lotExits([lot({ markSol: 0.12 })], P);
    expect(sl[0]).toMatchObject({ type: "sell", reason: expect.stringMatching(/stop-loss/) });
    const tr = lotExits([lot({ markSol: 0.3, peakMarkSol: 0.5 })], P);
    expect(tr[0]).toMatchObject({ type: "sell", reason: expect.stringMatching(/trailing/) });
    const ts = lotExits([lot({ openedAt: new Date(Date.now() - 200 * 60_000).toISOString() })], P);
    expect(ts[0]).toMatchObject({ type: "sell", reason: expect.stringMatching(/time stop/) });
    expect(lotExits([lot({ markSol: 0.25, peakMarkSol: 0.26 })], P)).toHaveLength(0);
  });
});

describe("rug watch", () => {
  it("sells immediately on a 50% drop inside 90 seconds, before the stop-loss would", () => {
    const now = Date.now();
    const l = lot({ markSol: 0.19, peakMarkSol: 0.2, marks: [{ ts: now - 60_000, markSol: 0.2 }, { ts: now - 10_000, markSol: 0.08 }] });
    l.markSol = 0.08;
    const r = lotExits([l], P, now);
    expect(r[0]).toMatchObject({ type: "sell", reason: expect.stringMatching(/RUG WATCH/) });
    const slow = lot({ markSol: 0.19, marks: [{ ts: now - 8 * 60_000, markSol: 0.4 }, { ts: now - 30_000, markSol: 0.2 }] });
    expect(lotExits([slow], P, now)).toHaveLength(0); // 90초 창 안에서는 −5% 뿐 — 러그가 아니다
  });
});

describe("applyOutcome", () => {
  it("raises standing on wins, lowers on losses, and drops a wallet that starves", () => {
    let f = follow;
    f = applyOutcome(f, 25, P).follow; expect(f.standing).toBeGreaterThan(1);
    f = applyOutcome(f, -40, P).follow; expect(f.standing).toBeLessThan(1.5);
    let drop = false;
    for (let i = 0; i < 6; i++) { const r = applyOutcome(f, -30, P); f = r.follow; drop = r.drop; }
    expect(drop).toBe(true);
    expect(f.standing).toBeGreaterThanOrEqual(0.1);
  });
});
