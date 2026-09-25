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
  it("ranks by median — one 100x with nine losers is not a copy target", () => {
    const trades: WalletTrade[] = [];
    // 지갑 LUCKY: 1번 100배, 9번 -50%
    for (let i = 0; i < 10; i++) { trades.push(t("LUCKY", `l${i}`, "buy", 1, 100, i * 2)); trades.push(t("LUCKY", `l${i}`, "sell", i === 0 ? 100 : 0.5, 100, i * 2 + 1)); }
    // 지갑 STEADY: 10번 +15%, 3번 -10%
    for (let i = 0; i < 13; i++) { trades.push(t("STEADY", `s${i}`, "buy", 1, 100, i * 2)); trades.push(t("STEADY", `s${i}`, "sell", i < 10 ? 1.15 : 0.9, 100, i * 2 + 1)); }
    const { ranked, eligible } = scoreWallets(trades);
    expect(ranked[0].wallet).toBe("STEADY");
    expect(eligible.map((w) => w.wallet)).toEqual(["STEADY"]);
    const lucky = ranked.find((w) => w.wallet === "LUCKY")!;
    expect(lucky.totalPnlSol).toBeGreaterThan(0); // 총액은 양수지만
    expect(lucky.medianPnlPct).toBeLessThan(0); // 중앙값이 음수라 탈락
  });
  it("requires a sample: too few round trips or too few mints is not eligible", () => {
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 3; i++) { trades.push(t("FEW", `f${i}`, "buy", 1, 100, i * 2)); trades.push(t("FEW", `f${i}`, "sell", 1.5, 100, i * 2 + 1)); }
    for (let i = 0; i < 12; i++) { trades.push(t("ONE", "same", "buy", 1, 100, i * 2)); trades.push(t("ONE", "same", "sell", 1.5, 100, i * 2 + 1)); }
    const { eligible } = scoreWallets(trades);
    expect(eligible).toHaveLength(0);
  });
});
