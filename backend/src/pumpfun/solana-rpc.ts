import { logger } from "../core/logger.js";
import { decodeCurveAccount, type CurveState } from "./curve.js";

/**
 * 키 없는 Solana JSON-RPC — 공개 엔드포인트, 전역 토큰버킷(초당 2회). onchain/rpc.ts와 같은 규율.
 * 용도는 하나: 보유 토큰의 본딩커브 계정을 읽어 **체결 스트림이 끊겨도 포지션을 마킹**한다.
 * 매매 경로가 아니다(페이퍼). 실패는 이유를 남기고 다음 주기에 다시 시도한다.
 */
const ENDPOINTS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
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
