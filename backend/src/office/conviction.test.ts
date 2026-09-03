import { describe, expect, it } from "vitest";
import { confidenceFromT, officeConfidence, parseChartMomentum, parseQuantEdge, pumpHeadlineShare } from "./conviction.js";

const QUANT = `# Crypto quant desk
## KRW-ARB — 2026-02-16 ~ 2026-09-03 (199 returns)
  risk (historical, daily): VaR95=4.65% VaR99=9.38% ES95=6.82% · maxDD=-53.0%
  Kelly (μ/σ², log-utility approx): full=0.181 half=0.091 — μ̂=0.029%/d σ̂=3.97%/d · treat as an upper bound on exposure, not a signal
## KRW-BTC — 2026-02-16 ~ 2026-09-03 (199 returns)
  Kelly (μ/σ², log-utility approx): full=0.5 half=0.25 — μ̂=0.300%/d σ̂=1.70%/d · treat as an upper bound
`;
const CHART = `# Upbit crypto report
## KRW-ARB — ₩181 (+5.85% 24h)
  trend: close ₩180 (2026-09-03) is ABOVE MA20 ₩131 → uptrend bias
  momentum call: positive — close moved ₩105 (2026-08-14) → ₩180 (2026-09-03), +71.43% over 20 sessions
## KRW-SC — ₩0.968 (-7.81% 24h)
  momentum call: positive — close moved ₩0.656 (2026-08-14) → ₩0.968 (2026-09-03), +47.56% over 20 sessions
## KRW-ZZZ — no data (skipped, not invented)
`;
const NEWS = `# Crypto news desk
## KRW-ARB — 4 headlines, aggregate BULLISH +0.642
  · [BULLISH +0.583 conf 0.5] "Arbitrum (ARB) Jumps 35%: …" — x · evidence: jumps
  · [BULLISH +0.583 conf 0.5] "Arbitrum Surges Over 14% in a Single Day" — x · evidence: surges
  · [BULLISH +0.87 conf 1] "ARB Price Surges 30%: Arbitrum Breaks Out as Volume Ignites Fresh Rally" — x · evidence: surges,rally
  · [BULLISH +0.322 conf 0.25] "Best Crypto Presales for September" — x · evidence: up
## KRW-INJ — 2 headlines, aggregate BULLISH +0.3
  · [BULLISH +0.583 conf 0.5] "Injective Clarifies Chain Upgrade" — x · evidence: upgrade
  · [BEARISH -0.583 conf 0.5] "Injective Crypto Fees Plunge 88%" — x · evidence: plunge
`;

describe("conviction", () => {
  it("reads μ̂/σ̂/n from the quant report and computes t", () => {
    const e = parseQuantEdge(QUANT);
    expect(e.map((x) => x.market)).toEqual(["KRW-ARB", "KRW-BTC"]);
    expect(e[0].t).toBeCloseTo((0.029 / 3.97) * Math.sqrt(199), 2); // ≈ 0.10 — no edge
    expect(e[1].t).toBeCloseTo((0.3 / 1.7) * Math.sqrt(199), 2); // ≈ 2.49
  });
  it("reads 24h change and 20-session momentum from the chart report, skipping no-data sections", () => {
    const m = parseChartMomentum(CHART);
    expect(m).toEqual([{ market: "KRW-ARB", chg24hPct: 5.85, mom20Pct: 71.43 }, { market: "KRW-SC", chg24hPct: -7.81, mom20Pct: 47.56 }]);
  });
  it("counts headlines that merely describe the pump", () => {
    expect(pumpHeadlineShare(NEWS, "KRW-ARB")).toEqual({ headlines: 4, pump: 3, share: 0.75 });
    expect(pumpHeadlineShare(NEWS, "KRW-INJ").share).toBe(0);
    expect(pumpHeadlineShare(NEWS, "KRW-NONE").headlines).toBe(0);
  });
  it("maps t to confidence: no edge ≈ 0.3, strong edge → 0.9, negative → floor 0.1", () => {
    expect(confidenceFromT(0)).toBe(0.3);
    expect(confidenceFromT(2.5)).toBe(0.9);
    expect(confidenceFromT(-1)).toBe(0.1);
  });
  it("office confidence is weight-averaged over positions, discounted when a review stood unresolved, 0.5 for cash", () => {
    const edges = parseQuantEdge(QUANT);
    const a = officeConfidence({ positions: [{ market: "KRW-ARB", weightPct: 20 }], edges, flagged: false });
    expect(a.confidence).toBeCloseTo(0.33, 2);
    const b = officeConfidence({ positions: [{ market: "KRW-BTC", weightPct: 30 }, { market: "KRW-ARB", weightPct: 10 }], edges, flagged: false });
    expect(b.confidence).toBeCloseTo((0.9 * 30 + 0.33 * 10) / 40, 1);
    const c = officeConfidence({ positions: [{ market: "KRW-BTC", weightPct: 30 }], edges, flagged: true });
    expect(c.confidence).toBeCloseTo(0.63, 2);
    expect(officeConfidence({ positions: [], edges, flagged: false }).confidence).toBe(0.5);
    expect(officeConfidence({ positions: [{ market: "KRW-NEW", weightPct: 10 }], edges: [], flagged: false }).confidence).toBe(0.3);
  });
});
