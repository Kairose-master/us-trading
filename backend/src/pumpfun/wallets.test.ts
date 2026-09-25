import { describe, expect, it } from "vitest";
import { roundTripsOf, scoreWallets, type WalletTrade } from "./wallets.js";

const t = (wallet: string, mint: string, side: "buy" | "sell", sol: number, tokens: number, min: number): WalletTrade => ({ wallet, mint, side, sol, tokens, ts: new Date(Date.UTC(2026, 8, 25, 0, min)).toISOString() });

describe("roundTripsOf", () => {
  it("closes a round trip on sell with pro-rata cost and ignores sells without an observed buy", () => {
    const r = roundTripsOf([t("A", "m1", "buy", 1, 1000, 0), t("A", "m1", "sell", 0.8, 500, 5), t("A", "m1", "sell", 0.9, 500, 9), t("B", "m2", "sell", 3, 10, 1)]);
    const a = r.get("A")!;
    expect(a).toHaveLength(2);
    expect(a[0].costSol).toBeCloseTo(0.5); expect(a[0].pnlSol).toBeCloseTo(0.3); expect(a[0].holdMin).toBe(5);
    expect(a[1].costSol).toBeCloseTo(0.5); expect(a[1].pnlSol).toBeCloseTo(0.4);
    expect(r.has("B")).toBe(false);
  });
});

describe("scoreWallets", () => {
  it("a skilled HFT wallet with a tiny median edge and 1-minute holds is not copyable", () => {
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 30; i++) { trades.push(t("HFT", `h${i}`, "buy", 1, 100, i * 2)); trades.push(t("HFT", `h${i}`, "sell", i % 2 ? 1.02 : 0.99, 100, i * 2 + 1)); }
    const { eligible, provisional, ranked } = scoreWallets(trades);
    expect(ranked[0].totalPnlSol).toBeGreaterThan(0);
    expect(eligible).toHaveLength(0); expect(provisional).toHaveLength(0);
  });
  it("a positive median with a negative total (a few big losses) is not followed", () => {
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 6; i++) { trades.push(t("BLOW", `b${i}`, "buy", 1, 100, i * 2)); trades.push(t("BLOW", `b${i}`, "sell", i < 4 ? 1.05 : 0.2, 100, i * 2 + 1)); }
    const { eligible, provisional } = scoreWallets(trades);
    expect(eligible).toHaveLength(0); expect(provisional).toHaveLength(0);
  });
  it("ignores dust buys — a 0.0002 SOL bot buy sold for 0.03 SOL is not a +15,000% round trip", () => {
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 6; i++) { trades.push(t("DUST", `d${i}`, "buy", 0.0002, 100, i * 2)); trades.push(t("DUST", `d${i}`, "sell", 0.03, 100, i * 2 + 1)); }
    const { ranked, provisional } = scoreWallets(trades);
    expect(ranked.find((w) => w.wallet === "DUST")?.roundTrips ?? 0).toBe(0);
    expect(provisional).toHaveLength(0);
  });
  it("ranks by median — one 100x with nine losers is not a copy target", () => {
    const trades: WalletTrade[] = [];
    // 지갑 LUCKY: 1번 100배, 9번 -50%
    for (let i = 0; i < 10; i++) { trades.push(t("LUCKY", `l${i}`, "buy", 1, 100, i * 2)); trades.push(t("LUCKY", `l${i}`, "sell", i === 0 ? 100 : 0.5, 100, i * 2 + 1)); }
    // 지갑 STEADY: 10번 +15%, 3번 -10%
    for (let i = 0; i < 13; i++) { trades.push(t("STEADY", `s${i}`, "buy", 1, 100, i * 2)); trades.push(t("STEADY", `s${i}`, "sell", i < 10 ? 1.15 : 0.9, 100, i * 2 + 5)); }
    const { ranked, eligible } = scoreWallets(trades);
    expect(ranked[0].wallet).toBe("STEADY");
    expect(eligible.map((w) => w.wallet)).toEqual(["STEADY"]);
    const lucky = ranked.find((w) => w.wallet === "LUCKY")!;
    expect(lucky.totalPnlSol).toBeGreaterThan(0); // 총액은 양수지만
    expect(lucky.medianPnlPct).toBeLessThan(0); // 중앙값이 음수라 탈락
  });
  it("requires a sample: too few round trips or too few mints is not eligible — but a small positive sample is provisional", () => {
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 3; i++) { trades.push(t("FEW", `f${i}`, "buy", 1, 100, i * 2)); trades.push(t("FEW", `f${i}`, "sell", 1.5, 100, i * 2 + 5)); }
    for (let i = 0; i < 12; i++) { trades.push(t("ONE", "same", "buy", 1, 100, i * 2)); trades.push(t("ONE", "same", "sell", 1.5, 100, i * 2 + 1)); }
    const { eligible, provisional } = scoreWallets(trades);
    expect(eligible).toHaveLength(0);
    expect(provisional.map((w) => w.wallet)).toEqual(["FEW"]); // 3 왕복·3 토큰·승률 100% → 잠정. ONE 은 토큰 1종이라 잠정도 아니다
  });
});
