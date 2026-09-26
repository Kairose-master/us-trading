import { describe, expect, it } from "vitest";
import { scoreCommunity, CommunityDesk, type CommunityFacts } from "./community.js";

const facts = (over: Partial<CommunityFacts> = {}): CommunityFacts => ({ mint: "m", fetchedAt: "t", ok: true, symbol: "X", creator: "C", ageMin: 30, replyCount: 0, replyPerMin: null, kothMinAgo: null, twitter: null, telegram: null, website: null, telegramMembers: null, isLive: false, mcapUsd: 10_000, athMcapUsd: 12_000, fromAth: 0.83, securityVerdict: "allow", complete: false, top10Share: null, creatorLaunches48h: 1, creatorSharePct: null, creatorInitialBuySol: null, ...over });

describe("scoreCommunity", () => {
  it("a bare token is neutral (zero replies is no longer a penalty); one far below ATH is skipped", () => {
    const r = scoreCommunity(facts());
    expect(r.score).toBe(50); expect(r.block).toBe(false); expect(r.multiplier).toBe(0.5);
    const dead = scoreCommunity(facts({ fromAth: 0.2 }));
    expect(dead.block).toBe(true); expect(dead.multiplier).toBe(0);
  });
  it("socials, replies, live stream and KOTH stack up to a size boost", () => {
    const r = scoreCommunity(facts({ twitter: "x", telegram: "t.me/a", telegramMembers: 2500, website: "w", replyCount: 60, replyPerMin: 3, isLive: true, kothMinAgo: 5 }));
    expect(r.score).toBe(100); expect(r.multiplier).toBe(1.25);
    expect(r.reasons.join(" ")).toMatch(/telegram 2500 members/);
  });
  it("blocks on a non-allow security verdict, a serial launcher, or extreme holder concentration", () => {
    expect(scoreCommunity(facts({ securityVerdict: "deny", twitter: "x", replyCount: 100 })).block).toBe(true);
    expect(scoreCommunity(facts({ creatorLaunches48h: 12, twitter: "x", replyCount: 100 })).block).toBe(true);
    expect(scoreCommunity(facts({ top10Share: 0.85, twitter: "x", replyCount: 100 })).block).toBe(true);
    const serial = scoreCommunity(facts({ creatorLaunches48h: 4, twitter: "x", telegram: "t", replyCount: 60 }));
    expect(serial.score).toBe(60); // 50 +10 +10 +15 −25
  });
  it("unknown data is neither positive nor a block — ×0.75", () => {
    const r = scoreCommunity(facts({ ok: false }));
    expect(r.unknown).toBe(true); expect(r.block).toBe(false); expect(r.multiplier).toBe(0.75);
  });
  it("gate can be switched off: score still computed, never blocks", () => {
    const r = scoreCommunity(facts({ fromAth: 0.1 }), { minScore: 40, gate: 0 });
    expect(r.block).toBe(false); expect(r.multiplier).toBe(0.5);
  });
});

describe("rug watch", () => {
  it("blocks a creator holding ≥10% or a ≥5 SOL bundled launch, and penalises smaller versions", () => {
    const good = facts({ twitter: "x", telegram: "t", replyCount: 60 });
    expect(scoreCommunity(good).score).toBe(85);
    expect(scoreCommunity({ ...good, creatorSharePct: 12 }).block).toBe(true);
    expect(scoreCommunity({ ...good, creatorInitialBuySol: 6 }).block).toBe(true);
    expect(scoreCommunity({ ...good, creatorSharePct: 5 }).score).toBe(65);
    expect(scoreCommunity({ ...good, creatorInitialBuySol: 2.5 }).score).toBe(70);
  });
});

describe("CommunityDesk creator ledger", () => {
  it("counts a creator's launches inside 48h and forgets older ones", () => {
    const d = new CommunityDesk();
    const now = Date.now();
    d.noteLaunch("C", now - 50 * 3_600_000); d.noteLaunch("C", now - 3_600_000); d.noteLaunch("C", now);
    expect(d.creatorLaunches48h("C")).toBe(2);
    expect(d.creatorLaunches48h("nobody")).toBeNull();
  });
});
