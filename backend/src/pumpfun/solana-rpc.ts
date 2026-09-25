import { logger } from "../core/logger.js";
import { decodeCurveAccount, type CurveState } from "./curve.js";

/**
 * 키 없는 Solana JSON-RPC — 공개 엔드포인트, 전역 토큰버킷(초당 2회). onchain/rpc.ts와 같은 규율.
 * 용도는 하나: 보유 토큰의 본딩커브 계정을 읽어 **체결 스트림이 끊겨도 포지션을 마킹**한다.
 * 매매 경로가 아니다(페이퍼). 실패는 이유를 남기고 다음 주기에 다시 시도한다.
 */
import { config } from "../config.js";

/** PUMPFUN_RPC_URL(Helius 등)이 있으면 그것부터 — 실주문 확인은 빠른 RPC가 낫다. 없으면 공개 엔드포인트 */
const ENDPOINTS = [...(config.PUMPFUN_RPC_URL ? [config.PUMPFUN_RPC_URL] : []), "https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const RATE_PER_SEC = 2;
let tokens = RATE_PER_SEC;
const waiters: Array<() => void> = [];
setInterval(() => { tokens = Math.min(RATE_PER_SEC, tokens + RATE_PER_SEC); while (tokens >= 1 && waiters.length) { tokens -= 1; waiters.shift()!(); } }, 1000).unref();
const acquire = () => (tokens >= 1 ? ((tokens -= 1), Promise.resolve()) : new Promise<void>((r) => waiters.push(r)));

export async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  let last = "";
  for (const url of ENDPOINTS) {
    await acquire();
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(12_000) });
      if (!res.ok) { last = `${url} HTTP ${res.status}`; continue; }
      const j = (await res.json()) as { result?: T; error?: { message: string } };
      if (j.error) { last = `${url} ${j.error.message}`; continue; }
      return j.result as T;
    } catch (e) { last = `${url} ${(e as Error).message}`; }
  }
  throw new Error(`solana rpc ${method} failed: ${last}`);
}

/** 본딩커브 계정 → 커브 상태. 계정이 없으면(이주 후 닫힘 등) null */
export async function readCurve(bondingCurveKey: string): Promise<(CurveState & { supply: number }) | null> {
  const r = await solanaRpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [bondingCurveKey, { encoding: "base64", commitment: "confirmed" }]);
  if (!r?.value) return null;
  try { return decodeCurveAccount(r.value.data[0]); } catch (e) { logger.warn("[pumpfun] curve decode failed", { key: bondingCurveKey, error: (e as Error).message }); return null; }
}

// ===== 실주문 확인용 =====

export async function walletSol(pubkey: string): Promise<number> {
  const r = await solanaRpc<{ value: number }>("getBalance", [pubkey, { commitment: "confirmed" }]);
  return (r?.value ?? 0) / 1e9;
}

export async function tokenBalance(pubkey: string, mint: string): Promise<number> {
  const r = await solanaRpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }> }>("getTokenAccountsByOwner", [pubkey, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  return (r?.value ?? []).reduce((a, x) => a + (x.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
}

export interface ParsedTx {
  slot: number; blockTime: number | null;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }>; postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }> } | null;
  transaction: { message: { accountKeys: Array<{ pubkey: string } | string> } };
}

export interface TxDeltas { ok: boolean; err: string | null; solDelta: number; tokenDelta: number; feeSol: number; slot: number; ts: string }

/** 트랜잭션에서 우리 지갑의 SOL·토큰 변화를 읽는다 — 체결가는 추정하지 않고 이것으로 계산한다 */
export function parseTxDeltas(tx: ParsedTx, pubkey: string, mint: string): TxDeltas {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const idx = keys.indexOf(pubkey);
  const meta = tx.meta;
  const ts = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString();
  if (!meta) return { ok: false, err: "no meta", solDelta: 0, tokenDelta: 0, feeSol: 0, slot: tx.slot, ts };
  const solDelta = idx >= 0 ? ((meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0)) / 1e9 : 0;
  const sum = (rows?: ParsedTx["meta"] extends null ? never : NonNullable<ParsedTx["meta"]>["preTokenBalances"]) => (rows ?? []).filter((r) => r.mint === mint && (r.owner === undefined || r.owner === pubkey)).reduce((a, r) => a + (r.uiTokenAmount.uiAmount ?? 0), 0);
  const tokenDelta = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
  return { ok: meta.err === null || meta.err === undefined, err: meta.err ? JSON.stringify(meta.err) : null, solDelta, tokenDelta, feeSol: (meta.fee ?? 0) / 1e9, slot: tx.slot, ts };
}

/** 서명이 확정될 때까지 기다렸다가 파싱한 트랜잭션을 돌려준다. 시간 내 확정이 없으면 null */
export async function waitForTx(signature: string, timeoutMs = 45_000): Promise<ParsedTx | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const st = await solanaRpc<{ value: Array<{ confirmationStatus?: string; err: unknown } | null> }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      const s = st?.value?.[0];
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" || s.err)) {
        const tx = await solanaRpc<ParsedTx | null>("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
        if (tx) return tx;
      }
    } catch (e) { logger.warn("[pumpfun] tx status poll failed", { signature: signature.slice(0, 12), error: (e as Error).message }); }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
}
