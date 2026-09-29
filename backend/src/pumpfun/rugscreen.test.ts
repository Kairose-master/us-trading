import { describe, expect, it } from "vitest";
import { DEFAULT_RUG_POLICY, dumpSignal, rugFeatures, rugVerdict, SUPPLY, watchEnabled, watchSet, type RugTrade } from "./rugscreen.js";

const T0 = 1_790_000_000_000;
const tr = (sec: number, wallet: string, side: 1 | -1, pctSupply: number, sol = 0.1): RugTrade => ({ ts: T0 + sec * 1000, wallet, side, sol, tokens: (pctSupply / 100) * SUPPLY, price: 1e-7 });

describe("rugFeatures", () => {
  it("reconstructs holder structure from trades: creator, bundle, top holders, sold fraction", () => {
    const trades = [
      tr(0, "dev", 1, 8), tr(1, "b1", 1, 3), tr(2, "b2", 1, 3), // 생성 3초 안 = 번들
      tr(30, "s1", 1, 2), // 60초 안 = 스나이퍼
      tr(120, "r1", 1, 1), tr(130, "r2", 1, 0.5), tr(140, "dev", -1, 2),
    ];
    const f = rugFeatures(trades, "dev", T0, T0 + 200_000, true);
    expect(f.creatorPct).toBeCloseTo(6);
    expect(f.creatorSoldFrac).toBeCloseTo(0.25);
    expect(f.bundle3sPct).toBeCloseTo(12); // dev 6 + b1 3 + b2 3
    expect(f.snipers60Pct).toBeCloseTo(14);
    expect(f.top1Pct).toBeCloseTo(6);
    expect(f.top10Pct).toBeCloseTo(15.5);
    expect(f.holders).toBe(6);
  });
  it("measures recent buyer diversity and wash-like repetition over the last 5 minutes", () => {
    const trades = [...Array(10)].map((_, i) => tr(600 + i, "wash", 1, 0.01, 1)).concat([tr(605, "a", 1, 0.01, 0.1), tr(606, "b", 1, 0.01, 0.1)]);
    const f = rugFeatures(trades, null, T0, T0 + 700_000, true);
    expect(f.uniqBuyers5m).toBe(3);
    expect(f.tradesPerWallet5m).toBeCloseTo(4);
    expect(f.top3BuyShare5m).toBeCloseTo(1);
    expect(f.creatorPct).toBeNull();
  });
});

describe("rug verdict and dump watch", () => {
  const trades = [tr(0, "dev", 1, 8), tr(1, "b1", 1, 3), tr(100, "whale", 1, 5), tr(120, "small", 1, 0.2)];
  it("blocks on configured holder-structure limits only when history is complete", () => {
    const p = { ...DEFAULT_RUG_POLICY, maxCreatorPct: 5, maxBundlePct: 10 };
    const f = rugFeatures(trades, "dev", T0, T0 + 200_000, true);
    const v = rugVerdict(f, p);
    expect(v.block).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/creator holds 8\.0% > 5%/);
    expect(v.reasons.join(" ")).toMatch(/bundle still holds 11\.0%/);
    expect(rugVerdict(rugFeatures(trades, "dev", T0, T0 + 200_000, false), p).block).toBe(false); // 불완전하면 보유 구조로는 안 막는다
    expect(rugVerdict(f, { ...p, on: 0 }).block).toBe(false);
  });
  it("defaults block the measured extremes and pass an ordinary launch", () => {
    const ordinary = rugFeatures([tr(0, "dev", 1, 3), tr(20, "a", 1, 2), tr(100, "b", 1, 3), tr(130, "c", 1, 1)], "dev", T0, T0 + 600_000, true);
    expect(rugVerdict(ordinary, DEFAULT_RUG_POLICY).block).toBe(false);
    const rug = rugFeatures([tr(0, "dev", 1, 24), tr(1, "x", 1, 17)], "dev", T0, T0 + 600_000, true);
    const v = rugVerdict(rug, DEFAULT_RUG_POLICY);
    expect(v.block).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/snipers hold 41\.0%/); // 개발자>10 은 최종 검증에서 뺐다 — 스나이퍼 규칙이 잡는다
    expect(v.reasons.join(" ")).not.toMatch(/creator holds/);
    const split = rugFeatures([...Array(130)].map((_, i) => tr(200 + i, `w${i}`, 1, 0.05)), null, T0, T0 + 10 * 60_000, true);
    expect(rugVerdict(split, DEFAULT_RUG_POLICY).reasons.join(" ")).toMatch(/130 holders within 10 min/);
  });
  it("watches the creator, launch bundle and big holders, and fires on their dumps", () => {
    const p = { ...DEFAULT_RUG_POLICY, watchHolderPct: 2, watchSellFrac: 0.5, watchCreator: 1 };
    const w = watchSet(trades, "dev", p);
    expect([...w.keys()].sort()).toEqual(["b1", "dev", "whale"]); // b1 은 3% 라 홀더 기준으로 들어간다
    expect([...watchSet([tr(0, "dev", 1, 5), tr(1, "tiny", 1, 0.5)], "dev", p).keys()]).toEqual(["dev"]); // 번들 감시는 기본 끔
    expect(watchEnabled(DEFAULT_RUG_POLICY)).toBe(false); // 기본은 보유 중 감시 전부 끔 — 폴링도 안 한다
    const sold = new Map<string, number>();
    expect(dumpSignal([tr(300, "small", -1, 0.2)], w, sold, "dev", p)).toBeNull();
    expect(dumpSignal([tr(301, "whale", -1, 2)], w, sold, "dev", p)).toBeNull(); // 5% 중 2% = 40%
    expect(dumpSignal([tr(302, "whale", -1, 1)], w, sold, "dev", p)).toMatch(/watched holder whal/); // 누적 60%
    expect(dumpSignal([tr(303, "dev", -1, 0.1)], w, new Map(), "dev", p)).toMatch(/creator sold/);
    expect(dumpSignal([tr(304, "anyone", -1, 3)], w, new Map(), "dev", { ...p, whaleSellPct: 2 })).toMatch(/whale dump/);
  });
});
