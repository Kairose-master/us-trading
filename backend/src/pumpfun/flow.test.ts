import { describe, expect, it } from "vitest";
import { flowRead, momentumRead, type CoinSnapshot, type FlowTrade } from "./flow.js";
import { attribute, communityVote, copyVote, ensemble, flowVote, momentumVote, DEFAULT_ENGINE_WEIGHTS as W, DEFAULT_ENSEMBLE_POLICY as P } from "./ensemble.js";

const now = 1_800_000_000_000;
const tr = (wallet: string, side: "buy" | "sell", sol: number, sAgo: number): FlowTrade => ({ wallet, side, sol, ts: now - sAgo * 1000 });
const ranked = (w: string) => (w.startsWith("R") ? 10 : 0);

describe("flowRead", () => {
  it("counts net flow, ranked-wallet flow and unique buyers inside the windows, ignoring dust", () => {
    const trades = [tr("R1", "buy", 1, 10), tr("R2", "buy", 0.5, 30), tr("R3", "sell", 0.2, 40), tr("X1", "buy", 0.3, 100), tr("X2", "buy", 0.0002, 5), tr("X3", "sell", 2, 400)];
    const f = flowRead("m", trades, now, ranked);
    expect(f.netSol60).toBeCloseTo(1.3); expect(f.netSol300).toBeCloseTo(1.6);
    expect(f.rankedNet60).toBeCloseTo(1.3); expect(f.rankedBuyers60).toBe(2); expect(f.rankedSellers60).toBe(1);
    expect(f.uniqueBuyers300).toBe(3); expect(f.n300).toBe(4);
  });
});

describe("momentumRead", () => {
  it("reads mcap change vs 1m/5m-old snapshots, reply growth, migration recency and fade from peak", () => {
    const snap = (sAgo: number, mcap: number, replies: number): CoinSnapshot => ({ ts: now - sAgo * 1000, marketCapSol: mcap, replyCount: replies, isLive: false, kothAt: null, complete: true, createdAt: now - 3_600_000, lastTradeAt: now - 5_000, vSol: 115 });
    const m = momentumRead("m", [snap(330, 100, 10), snap(200, 140, 14), snap(70, 130, 18), snap(0, 120, 20)], now, now - 10 * 60_000);
    expect(m.mcap5mPct).toBeCloseTo(20); expect(m.mcap1mPct).toBeCloseTo(-7.69, 1); expect(m.replies5m).toBe(10);
    expect(m.sinceMigrationMin).toBeCloseTo(10); expect(m.fromPeak5mPct).toBeCloseTo(-14.29, 1); expect(m.curveProgress).toBeNull();
  });
});

describe("ensemble", () => {
  it("enters only when at least two engines vote and the weighted score clears the bar; community can block", () => {
    const f = flowVote(flowRead("m", [tr("R1", "buy", 1, 10), tr("R2", "buy", 1, 20), tr("R3", "buy", 1, 30), tr("X1", "buy", 1, 40), tr("X2", "buy", 1, 50), tr("X3", "buy", 1, 60), tr("X4", "buy", 1, 70), tr("X5", "buy", 1, 80), tr("X6", "sell", 0.5, 90)], now, ranked), P);
    expect(f.abstain).toBe(false); expect(f.score).toBeGreaterThan(80);
    const m = momentumVote({ mint: "m", ageMin: 15, mcap5mPct: 35, mcap1mPct: 5, replies5m: 6, sinceMigrationMin: 8, curveProgress: null, isLive: false, kothMinAgo: null, fromPeak5mPct: -3, secondsSinceTrade: 4 });
    expect(m.score).toBeGreaterThan(80);
    const c = copyVote([{ wallet: "F1", standing: 0.5, minAgo: 2 }], []);
    const votes = [f, m, c, communityVote(null)];
    const r = ensemble("m", votes, W, P, false, null, null, null);
    expect(r.action).toBe("enter"); expect(r.score).toBeGreaterThan(P.enterScore); expect(r.sizeMult).toBeGreaterThan(0);
    const blocked = ensemble("m", votes, W, P, false, { score: 10, multiplier: 0, block: true, unknown: false, reasons: ["x"], facts: {} as never }, null, null);
    expect(blocked.action).toBe("none"); expect(blocked.blocked).toBe(true);
    const lonely = ensemble("m", [f, momentumVote(null), copyVote([], []), communityVote(null)], W, P, false, null, null, null);
    expect(lonely.action).toBe("none"); // 엔진 하나로는 진입 안 함
    const momPlusCommunity = ensemble("m", [flowVote(null, P), m, copyVote([], []), { engine: "community", score: 90, abstain: false, why: [] }], W, P, false, null, null, null);
    expect(momPlusCommunity.action).toBe("none"); // 커뮤니티는 근거가 아니라 게이트
  });
  it("exits a held token on flow reversal or momentum fade even if the score is still fine", () => {
    const f = flowRead("m", [tr("R1", "sell", 1, 10), tr("R2", "sell", 1, 20)], now, ranked);
    const r = ensemble("m", [flowVote(null, P), momentumVote(null), copyVote([], []), communityVote(null)], W, P, true, null, f, null);
    expect(r.action).toBe("exit"); expect(r.why).toMatch(/flow reversal/);
    const m = { mint: "m", ageMin: 15, mcap5mPct: 0, mcap1mPct: 0, replies5m: 0, sinceMigrationMin: 8, curveProgress: null, isLive: false, kothMinAgo: null, fromPeak5mPct: -30, secondsSinceTrade: 4 };
    expect(ensemble("m", [], W, P, true, null, null, m).why).toMatch(/fade/);
  });
  it("attribution moves the weight of engines that leaned into the trade, by the realized result", () => {
    const votes = [{ engine: "flow" as const, score: 90, abstain: false, why: [] }, { engine: "momentum" as const, score: 30, abstain: false, why: [] }, { engine: "copy" as const, score: 50, abstain: true, why: [] }];
    const up = attribute(W, votes, 20);
    expect(up.flow).toBeGreaterThan(1); expect(up.momentum).toBeLessThan(1); expect(up.copy).toBe(1);
    const down = attribute(W, votes, -20);
    expect(down.flow).toBeLessThan(1); expect(down.momentum).toBeGreaterThan(1);
  });
});
