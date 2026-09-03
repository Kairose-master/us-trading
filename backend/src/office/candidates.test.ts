import { describe, expect, it } from "vitest";
import { buildOfficeCandidates } from "./candidates.js";
import type { CoinScore } from "../crypto/scanner.js";

const sc = (market: string, o: Partial<CoinScore>): CoinScore => ({ market, priceKrw: 1, valueKrw24h: 1e9, mom20Pct: 10, mom60Pct: 20, vol20Pct: 4, pBull: 0.8, regime: "bull", garchSigmaPct: 4, score: 1, ...o } as CoinScore);
const MAJ = ["KRW-BTC", "KRW-ETH"];

describe("office candidates", () => {
  it("always includes majors and holdings, then ranks the rest by 60d return / vol", () => {
    const r = buildOfficeCandidates({ scores: [sc("KRW-BTC", {}), sc("KRW-AAA", { mom60Pct: 60, vol20Pct: 3 }), sc("KRW-BBB", { mom60Pct: 30, vol20Pct: 3 }), sc("KRW-HELD", { mom60Pct: -5 })], majors: MAJ, held: ["KRW-HELD"], max: 8 });
    expect(r.markets.slice(0, 3)).toEqual(["KRW-BTC", "KRW-ETH", "KRW-HELD"]);
    expect(r.markets.indexOf("KRW-AAA")).toBeLessThan(r.markets.indexOf("KRW-BBB"));
  });
  it("excludes overheated names (20d ≥ 40%) unless held, and marks hot ones", () => {
    const r = buildOfficeCandidates({ scores: [sc("KRW-PUMP", { mom20Pct: 71, mom60Pct: 200 }), sc("KRW-WARM", { mom20Pct: 30, mom60Pct: 50 }), sc("KRW-HOTHELD", { mom20Pct: 55, mom60Pct: 90 })], majors: [], held: ["KRW-HOTHELD"], max: 8 });
    expect(r.markets).not.toContain("KRW-PUMP");
    expect(r.excluded.find((e) => e.market === "KRW-PUMP")?.why).toMatch(/overheated/);
    expect(r.markets).toContain("KRW-HOTHELD");
    expect(r.hot.sort()).toEqual(["KRW-HOTHELD", "KRW-WARM"]);
  });
  it("drops bearish-regime and non-positive names and respects max", () => {
    const many = Array.from({ length: 12 }, (_, i) => sc(`KRW-C${i}`, { mom60Pct: 10 + i }));
    const r = buildOfficeCandidates({ scores: [...many, sc("KRW-BEAR", { pBull: 0.2, mom60Pct: 500 }), sc("KRW-NEG", { mom60Pct: -3 })], majors: MAJ, held: [], max: 6 });
    expect(r.markets.length).toBe(6);
    expect(r.markets).not.toContain("KRW-BEAR");
    expect(r.markets).not.toContain("KRW-NEG");
    expect(r.markets).toContain("KRW-C11");
  });
});
