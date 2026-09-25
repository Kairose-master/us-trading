import { describe, expect, it } from "vitest";
import { normalize } from "./feed.js";

describe("normalize (PumpPortal message shapes captured 2026-09-25)", () => {
  it("maps a create event", () => {
    const ev = normalize({ signature: "sig", mint: "9KdL…pump", traderPublicKey: "A7tK", txType: "create", initialBuy: 26249942.945191, solAmount: 0.75232696, bondingCurveKey: "76MZ", vTokensInBondingCurve: 1046750057.054809, vSolInBondingCurve: 30.752326960049544, marketCapSol: 29.378863419005594, name: "MEME COIN FACTORY", symbol: "factory", uri: "ipfs", is_mayhem_mode: false, pool: "pump" }, "t");
    expect(ev).toMatchObject({ kind: "create", mint: "9KdL…pump", creator: "A7tK", initialBuySol: 0.75232696, vSol: 30.752326960049544, symbol: "factory" });
  });
  it("maps buy/sell trades and defaults the pool to pump", () => {
    const ev = normalize({ signature: "s", mint: "m", traderPublicKey: "w", txType: "buy", tokenAmount: 1000, solAmount: 0.1, newTokenBalance: 1000, bondingCurveKey: "b", vTokensInBondingCurve: 1e9, vSolInBondingCurve: 31, marketCapSol: 31 }, "t");
    expect(ev).toMatchObject({ kind: "trade", side: "buy", wallet: "w", tokens: 1000, sol: 0.1, pool: "pump", bondingCurveKey: "b" });
  });
  it("ignores server notices", () => {
    expect(normalize({ message: "Successfully subscribed to token creation events." })).toBeNull();
  });
});
