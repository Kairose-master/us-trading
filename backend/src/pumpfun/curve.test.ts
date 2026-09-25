import { describe, expect, it } from "vitest";
import { decodeCurveAccount, liquidationValue, marketCapSol, progress, quoteBuy, quoteSell, spotPrice, INITIAL_V_SOL, INITIAL_V_TOKENS } from "./curve.js";

const fresh = { vSol: INITIAL_V_SOL, vTokens: INITIAL_V_TOKENS, rTokens: 793_100_000, rSol: 0 };

describe("bonding curve math", () => {
  it("prices a fresh curve at 30 SOL / 1.073B tokens ≈ 28 SOL market cap", () => {
    expect(spotPrice(fresh)).toBeCloseTo(30 / 1_073_000_000, 15);
    expect(marketCapSol(fresh)).toBeCloseTo(27.96, 1);
    expect(progress(fresh)).toBe(0);
  });
  it("buy: fee comes off the SOL first, tokens follow x·y=k, and impact grows with size", () => {
    const small = quoteBuy(fresh, 0.1);
    const big = quoteBuy(fresh, 10);
    expect(small.feeSol).toBeCloseTo(0.00125, 10);
    expect(small.tokens).toBeGreaterThan(0);
    expect(small.impactPct).toBeGreaterThan(1.2); // 수수료 1.25% + 약간의 임팩트
    expect(big.impactPct).toBeGreaterThan(small.impactPct);
    // k 보존 (수수료를 뗀 SOL만 준비금에 들어간다)
    expect(big.next.vSol * big.next.vTokens).toBeCloseTo(fresh.vSol * fresh.vTokens, 0);
    expect(big.next.vSol).toBeCloseTo(30 + 10 * (1 - 0.0125), 9);
  });
  it("round trip loses about two fees plus impact — never a free lunch", () => {
    const b = quoteBuy(fresh, 1);
    const s = quoteSell(b.next, b.tokens);
    expect(s.sol).toBeLessThan(1);
    expect(s.sol).toBeGreaterThan(1 * (1 - 0.0125) ** 2 - 0.001);
    expect(s.next.vSol).toBeCloseTo(fresh.vSol, 6);
  });
  it("cannot buy more than the real token reserve — the curve completes", () => {
    const f = quoteBuy({ ...fresh, rTokens: 1_000 }, 5);
    expect(f.tokens).toBe(1_000);
    expect(f.next.complete).toBe(true);
  });
  it("liquidation value of a large position is below spot × qty", () => {
    const b = quoteBuy(fresh, 20);
    expect(liquidationValue(b.next, b.tokens)).toBeLessThan(spotPrice(b.next) * b.tokens);
  });
  it("decodes a real bonding-curve account (captured 2026-09-25)", () => {
    // 4f7K69yWBsK8Ft1vKgA3SLQnFQ4c75GHiiZd5SktYk4e 의 실물 데이터
    const c = decodeCurveAccount("F7f4N2DYrGAN8pChO8wDAMDKdOoRAAAADVp+VarNAgABAAAAAAAAAACAxqR+jQMAAM0ghZKsofRR7lH6t2RcwfY9oi6SF67hvEwS92++XxuUAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(c.supply).toBe(1_000_000_000);
    expect(c.vTokens).toBeGreaterThan(1_000_000_000);
    expect(c.complete).toBe(false);
  });
});
