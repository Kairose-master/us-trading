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

/**
 * eth_getLogs는 공개 엔드포인트마다 제한이 크게 다르다 — 실측:
 *   publicnode      archive 조회 자체를 거부 (유료 토큰 요구)
 *   flashbots       최대 10만 블록
 *   drpc            무료 플랜 1만 블록
 *   blastapi        10 블록(!)
 *   tenderly public 20만 블록 OK  ← 그래서 로그는 여기부터 시도한다
 */
const LOG_ENDPOINTS: Record<string, string[]> = {
  ethereum: ["https://gateway.tenderly.co/public/mainnet", "https://rpc.flashbots.net", "https://eth.drpc.org"],
  "arbitrum-one": ["https://gateway.tenderly.co/public/arbitrum", "https://arb1.arbitrum.io/rpc"],
  base: ["https://gateway.tenderly.co/public/base", "https://mainnet.base.org"],
  "binance-smart-chain": ["https://bsc-rpc.publicnode.com"],
  polygon: ["https://gateway.tenderly.co/public/polygon"],
};

const RATE_PER_SEC = 5;
let tokens = RATE_PER_SEC;
const waiters: Array<() => void> = [];
setInterval(() => { tokens = Math.min(RATE_PER_SEC, tokens + RATE_PER_SEC); while (tokens >= 1 && waiters.length) { tokens -= 1; waiters.shift()!(); } }, 1000).unref();
const acquire = () => (tokens >= 1 ? ((tokens -= 1), Promise.resolve()) : new Promise<void>((r) => waiters.push(r)));

const TIMEOUT = 15_000;

export class RpcError extends Error {}

export async function rpc<T>(chain: string, method: string, params: unknown[], preferLogEndpoints = false): Promise<T> {
  const urls = preferLogEndpoints ? [...(LOG_ENDPOINTS[chain] ?? []), ...(ENDPOINTS[chain] ?? [])] : ENDPOINTS[chain];
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
export const blockNumber = async (chain: string) => Number(BigInt(await rpc<string>(chain, "eth_blockNumber", [])));

/** 블록 번호 → 그 블록의 유닉스 타임스탬프(초). 이벤트 스터디의 "공표 시각"이 여기서 나온다 */
export async function blockTimestamp(chain: string, block: number): Promise<number | null> {
  const b = await rpc<{ timestamp: string } | null>(chain, "eth_getBlockByNumber", ["0x" + block.toString(16), false]);
  if (!b?.timestamp) return null;
  try { return Number(BigInt(b.timestamp)); } catch { return null; }
}

export interface Log { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }
/**
 * 로그 조회 — 범위가 크면 거절하는 엔드포인트가 많으니 20만 → 10만 → 1만으로 줄여가며 시도한다.
 * 못 읽으면 빈 배열이 아니라 예외다 ("이벤트가 없다"와 "못 읽었다"는 다른 말).
 */
export async function getLogs(chain: string, address: string, topics: (string | string[])[], spanBlocks: number): Promise<{ logs: Log[]; fromBlock: number; toBlock: number }> {
  const head = await blockNumber(chain);
  let last = "";
  for (const span of [spanBlocks, 100_000, 10_000].filter((s, i, a) => s <= spanBlocks && a.indexOf(s) === i)) {
    const from = Math.max(0, head - span);
    try {
      const logs = await rpc<Log[]>(chain, "eth_getLogs", [{ address, topics, fromBlock: "0x" + from.toString(16), toBlock: "latest" }], true);
      return { logs, fromBlock: from, toBlock: head };
    } catch (e) { last = (e as Error).message; }
  }
  throw new RpcError(last || "eth_getLogs 실패");
}
/**
 * 명시적 [from, to] 구간의 로그 — 20만 → 10만 → 1만 블록으로 청크를 줄여가며 시도한다.
 * getLogs()와 달리 "지금부터 얼마나 과거로"가 아니라 임의의 과거 구간을 받는다 —
 * 여러 청크를 이어붙여 head보다 훨씬 오래된 이력을 훑을 때 쓴다.
 */
async function getLogsWindow(chain: string, address: string, topics: (string | string[])[], fromBlock: number, toBlock: number): Promise<Log[]> {
  const span = toBlock - fromBlock;
  let last = "";
  for (const chunk of [span, 100_000, 10_000].filter((s, i, a) => s <= span + 1 && a.indexOf(s) === i)) {
    const out: Log[] = [];
    try {
      for (let f = fromBlock; f <= toBlock; f += chunk) {
        const t = Math.min(toBlock, f + chunk - 1);
        const logs = await rpc<Log[]>(chain, "eth_getLogs", [{ address, topics, fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16) }], true);
        out.push(...logs);
      }
      return out;
    } catch (e) { last = (e as Error).message; }
  }
  throw new RpcError(last || "eth_getLogs 실패");
}

/**
 * 과거로 거슬러 올라가며 로그를 모은다 — 공개 엔드포인트의 단일 호출 범위 제한(실측 최대 20만 블록,
 * `getLogs()`의 주석 참조) 안에서 여러 청크를 이어붙인다. 실패한 청크는 건너뛰고 어디를 못 읽었는지
 * 그대로 남긴다 — "그 구간엔 이벤트가 없었다"와 "그 구간을 못 읽었다"를 섞지 않는다.
 */
export async function getLogsHistory(p: {
  chain: string; address: string; topics: (string | string[])[];
  totalSpanBlocks: number; chunkBlocks?: number; onChunk?: (done: number, total: number) => void;
}): Promise<{ logs: Log[]; fromBlock: number; toBlock: number; failedRanges: Array<{ from: number; to: number; error: string }> }> {
  const head = await blockNumber(p.chain);
  const chunk = p.chunkBlocks ?? 190_000;
  const from0 = Math.max(0, head - p.totalSpanBlocks);
  const logs: Log[] = [];
  const failedRanges: Array<{ from: number; to: number; error: string }> = [];
  const ranges: Array<[number, number]> = [];
  for (let f = from0; f <= head; f += chunk) ranges.push([f, Math.min(head, f + chunk - 1)]);
  let done = 0;
  for (const [f, t] of ranges) {
    try { logs.push(...(await getLogsWindow(p.chain, p.address, p.topics, f, t))); }
    catch (e) { failedRanges.push({ from: f, to: t, error: (e as Error).message.slice(0, 160) }); }
    done++; p.onChunk?.(done, ranges.length);
  }
  return { logs, fromBlock: from0, toBlock: head, failedRanges };
}

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
