import { describe, expect, it } from "vitest";
import { deflatedSharpe, expectedMaxSharpe, moments, normCdf, normPpf } from "./deflated-sharpe.js";

const gauss = (n: number, mean: number, sd: number, seed = 7) => {
  let s = seed;
  const u = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: n }, () => mean + sd * Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()));
};

describe("normal helpers", () => {
  it("cdf and ppf agree with known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normCdf(-2.326348)).toBeCloseTo(0.01, 5);
    expect(normPpf(0.975)).toBeCloseTo(1.959964, 5);
    expect(normPpf(0.5)).toBeCloseTo(0, 8);
    expect(normPpf(1 - 1e-4)).toBeCloseTo(3.719016, 4);
  });
  it("round-trips", () => { for (const z of [-2.5, -0.3, 0.8, 3.1]) expect(normPpf(normCdf(z))).toBeCloseTo(z, 4); });
});

describe("moments", () => {
  it("gives sample mean, sd, skew and raw kurtosis (3 for normal)", () => {
    const m = moments(gauss(4000, 0.001, 0.02));
    expect(m.mean).toBeCloseTo(0.001, 3);
    expect(m.sd).toBeCloseTo(0.02, 3);
    expect(Math.abs(m.skew)).toBeLessThan(0.2);
    expect(m.kurtosis).toBeCloseTo(3, 0);
    expect(m.sharpe).toBeCloseTo(0.05, 1);
  });
  it("is safe on degenerate input", () => {
    expect(moments([]).n).toBe(0);
    expect(moments([0.01, 0.01, 0.01]).sd).toBe(0);
    expect(moments([0.01, 0.01]).sharpe).toBe(0);
  });
});

describe("expected max Sharpe under the null", () => {
  it("grows with the number of trials and with their spread", () => {
    const a = expectedMaxSharpe(10, 0.01), b = expectedMaxSharpe(1000, 0.01);
    expect(b).toBeGreaterThan(a);
    expect(expectedMaxSharpe(100, 0.04)).toBeGreaterThan(expectedMaxSharpe(100, 0.01));
    expect(expectedMaxSharpe(100, 0)).toBe(0);
  });
});

describe("deflated Sharpe", () => {
  it("a real edge with one trial stays significant", () => {
    const d = deflatedSharpe({ returns: gauss(500, 0.004, 0.02), trials: 1 });
    expect(d.sr0).toBe(0);
    expect(d.dsr).toBeGreaterThan(0.95);
    expect(d.significant).toBe(true);
    expect(d.note).toMatch(/single trial/);
  });
  it("the same track record stops being significant once you admit how many trials produced it", () => {
    const returns = gauss(120, 0.003, 0.02);
    const trialSharpes = gauss(40, 0.05, 0.12, 13);
    const one = deflatedSharpe({ returns, trials: 1 });
    const many = deflatedSharpe({ returns, trials: 40, trialSharpes });
    expect(many.sr0).toBeGreaterThan(0);
    expect(many.dsr).toBeLessThan(one.dsr);
    expect(many.note).toMatch(/deflated by 40 trials/);
  });
  it("says so when trials were claimed but no spread was given", () => {
    const d = deflatedSharpe({ returns: gauss(200, 0.002, 0.02), trials: 25 });
    expect(d.sr0).toBe(0);
    expect(d.note).toMatch(/no spread/);
  });
  it("annualises for display only and reports the moments it used", () => {
    const d = deflatedSharpe({ returns: gauss(400, 0.001, 0.02), trials: 5, trialSharpes: [0.01, 0.05, 0.09], periodsPerYear: 365 });
    expect(d.sharpeAnnual).toBeCloseTo(d.sharpe * Math.sqrt(365), 3);
    expect(d.kurtosis).toBeGreaterThan(2);
    expect(d.n).toBe(400);
  });
  it("is zero, not NaN, on a flat or empty series", () => {
    expect(deflatedSharpe({ returns: [], trials: 3 }).dsr).toBe(0);
    expect(deflatedSharpe({ returns: [0.01, 0.01, 0.01], trials: 3 }).dsr).toBe(0);
  });
});
