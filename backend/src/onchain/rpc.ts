import { logger } from "../core/logger.js";

/**
 * 키 없는 EVM JSON-RPC — 공개 엔드포인트 몇 개를 순서대로 시도한다.
 * 우리 Upbit 클라이언트와 같은 규율: 프로세스 전역 토큰버킷, 실패는 조용히 넘기지 않고
 * 이유를 남긴다. 컨트랙트 분석은 매매 경로가 아니므로(읽기 전용) 실패해도 장부에 영향 없다.
 */

const ENDPOINTS: Record<string, string[]> = {
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://rpc.flashbots.net", "https://eth.drpc.org"],
  "arbitrum-one": ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
  base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  "binance-smart-chain": ["https://bsc-rpc.publicnode.com"],
  polygon: ["https://polygon-bor-rpc.publicnode.com"],
};

export const SUPPORTED_CHAINS = Object.keys(ENDPOINTS);

const RATE_PER_SEC = 5;
let tokens = RATE_PER_SEC;
const waiters: Array<() => void> = [];
setInterval(() => { tokens = Math.min(RATE_PER_SEC, tokens + RATE_PER_SEC); while (tokens >= 1 && waiters.length) { tokens -= 1; waiters.shift()!(); } }, 1000).unref();
const acquire = () => (tokens >= 1 ? ((tokens -= 1), Promise.resolve()) : new Promise<void>((r) => waiters.push(r)));

const TIMEOUT = 15_000;

export class RpcError extends Error {}

export async function rpc<T>(chain: string, method: string, params: unknown[]): Promise<T> {
  const urls = ENDPOINTS[chain];
  if (!urls) throw new RpcError(`체인 ${chain}은 지원 목록에 없다 (${SUPPORTED_CHAINS.join(", ")})`);
  let last = "";
  for (const url of urls) {
    await acquire();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) { last = `${url} → HTTP ${res.status}`; continue; }
      const j = (await res.json()) as { result?: T; error?: { message?: string } };
      if (j.error) { last = `${url} → ${j.error.message ?? "rpc error"}`; continue; }
      if (j.result === undefined) { last = `${url} → no result`; continue; }
      return j.result;
    } catch (e) {
      last = `${url} → ${(e as Error).message}`;
    }
  }
  throw new RpcError(last || `${method} 실패`);
}

/** eth_call — 리버트는 예외가 아니라 null (owner()가 없는 토큰은 정상이다) */
export async function ethCall(chain: string, to: string, data: string): Promise<string | null> {
  try { return await rpc<string>(chain, "eth_call", [{ to, data }, "latest"]); }
  catch (e) { if (/revert|execution reverted/i.test((e as Error).message)) return null; logger.warn("[onchain] eth_call failed", { to, data, error: (e as Error).message.slice(0, 120) }); return null; }
}
export const getCode = (chain: string, address: string) => rpc<string>(chain, "eth_getCode", [address, "latest"]);
export const getStorageAt = (chain: string, address: string, slot: string) => rpc<string>(chain, "eth_getStorageAt", [address, slot, "latest"]);

/** 32바이트 hex → 10진 문자열 (BigInt) */
export function decodeUint(hex: string | null): string | null {
  if (!hex || hex === "0x") return null;
  try { return BigInt(hex).toString(); } catch { return null; }
}
export function decodeUint8(hex: string | null): number | null {
  const s = decodeUint(hex);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
}
export function decodeAddress(hex: string | null): string | null {
  if (!hex || hex.length < 42) return null;
  const a = "0x" + hex.replace(/^0x/, "").slice(-40);
  return /^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() : null;
}
