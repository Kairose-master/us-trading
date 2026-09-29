import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// 돈이 나가는 경로 — 체인·PumpPortal 호출은 전부 가짜로 바꾸고 "승인 없이는 매수가 안 나간다"만 본다
const trades: Array<{ action: string; amount: unknown }> = [];
vi.mock("./live.js", async (orig) => ({ ...(await orig<typeof import("./live.js")>()), executeTrade: vi.fn(async (_k: string, req: { action: string; amount: unknown }) => { trades.push(req); return { signature: "sig", via: "lightning" }; }) }));
vi.mock("./solana-rpc.js", async (orig) => ({ ...(await orig<typeof import("./solana-rpc.js")>()), tokenBalance: vi.fn(async () => 0), walletSol: vi.fn(async () => 2), usdcBalance: vi.fn(async () => 0), solUsdPrice: vi.fn(async () => 0), waitForTx: vi.fn(async () => null), walletTokenBalances: vi.fn(async () => [{ mint: "MintWalletOnly", amount: 5e6 }]) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let d: any;
const ev = (mint: string) => ({ kind: "trade", ts: new Date().toISOString(), mint, wallet: "", side: "buy", sol: 1, tokens: 1e6, pool: "pump", bondingCurveKey: "", vSol: 30, vTokens: 1e9, newTokenBalance: 0, marketCapSol: 30, signature: "" });
const buy = (mint: string) => ({ type: "buy", mint, solIn: 0.1, via: "rule:conviction", reason: "test" });

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "pf-approval-")));
  d = (await import("./desk.js")).pumpfunDesk;
  d.modeSt = { mode: "real", since: null, by: null, walletPubkey: "WalletPubkey1111111111111111111111111111111" };
  d.liveSt.walletSol = 2;
});

describe("manual approval gate", () => {
  it("is on by default and only proposes — nothing is sent to the chain", async () => {
    expect(d.liveSt.policy.manualApproval).toBe(1);
    await d.applyLive(buy("MintA"), ev("MintA"), 1, 1, 40);
    expect(trades).toHaveLength(0);
    const list = d.pendingList();
    expect(list).toHaveLength(1);
    expect(list[0].mint).toBe("MintA");
    expect(list[0].suggestedSol).toBeCloseTo(0.8); // 에쿼티 2 × 40%
  });
  it("does not duplicate a pending mint, and a rejected mint is not re-proposed", async () => {
    await d.applyLive(buy("MintA"), ev("MintA"), 1, 1, 40);
    expect(d.pendingList()).toHaveLength(1);
    expect(d.rejectPending(d.pendingList()[0].id, "t")).toEqual({});
    await d.applyLive(buy("MintA"), ev("MintA"), 1, 1, 40);
    expect(d.pendingList()).toHaveLength(0);
    expect(trades).toHaveLength(0);
  });
  it("approval sends exactly the approved size, once", async () => {
    await d.applyLive(buy("MintB"), ev("MintB"), 1, 1, 40);
    const [p] = d.pendingList();
    const r = await d.approvePending(p.id, 0.5, "owner");
    expect(trades).toEqual([expect.objectContaining({ action: "buy", amount: 0.5 })]);
    expect(r.error).toBeUndefined();
    expect(await d.approvePending(p.id, 0.5, "owner")).toEqual({ error: "없거나 만료된 제안" }); // 두 번 눌러도 한 번
    expect(trades).toHaveLength(1);
  });
  it("expired proposals are dropped and cannot be approved", async () => {
    await d.applyLive(buy("MintC"), ev("MintC"), 1, 1, 40);
    const [p] = d.pendingList();
    d.pending.get(p.id).expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(await d.approvePending(p.id, undefined, "owner")).toEqual({ error: "없거나 만료된 제안" });
    expect(trades).toHaveLength(1);
  });
  it("never sells a coin the owner did not approve; sells approved ones", async () => {
    const open = (mint: string) => { const r = d.liveLedger.openFromFill({ mint, symbol: "X", pool: "pump", bondingCurveKey: null, curve: null, tokens: 1e6, costSol: 0.5, via: "chain:adopted", reason: "t", signature: "" }); d.liveLedger.lots.get(r.lot.id).markSol = 0.4; return r.lot.id; };
    const n = trades.length;
    const stranger = open("MintManual");
    await d.applyLive({ type: "sell", lotId: stranger, fraction: 1, reason: "stop-loss" });
    expect(trades.length).toBe(n); // 승인 안 한 코인 — 매도 안 나감
    expect(d.isManagedMint("MintB")).toBe(true); // 승인해서 산 코인은 관리 대상
    const mine = open("MintB");
    await d.applyLive({ type: "sell", lotId: mine, fraction: 1, reason: "stop-loss" });
    expect(trades.length).toBe(n + 1);
    expect(trades[trades.length - 1]).toEqual(expect.objectContaining({ action: "sell" }));
  });
  it("reconcile does not adopt wallet tokens the owner never approved", async () => {
    const r = await d.reconcileLive();
    expect(r.adopted).not.toContain("MintWalletOnly");
    expect(d.liveLedger.lotsOf("MintWalletOnly")).toHaveLength(0);
  });
  it("with manual approval off, the bot buys on its own again", async () => {
    d.setLivePolicy({ manualApproval: 0 });
    await d.applyLive(buy("MintD"), ev("MintD"), 1, 1, 40);
    expect(trades.filter((t) => t.action === "buy")).toHaveLength(2);
    expect(d.pendingList()).toHaveLength(0);
  });
});
