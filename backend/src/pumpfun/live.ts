import { logger } from "../core/logger.js";

/**
 * pump.fun 실주문 — PumpPortal Lightning Transaction API. 돈이 나가는 유일한 경로.
 *   POST https://pumpportal.fun/api/trade?api-key=…  { action, mint, amount, denominatedInSol, slippage, priorityFee, pool }
 *   → { signature } 또는 { errors: [...] }. PumpPortal이 연결된 지갑으로 서명·전송한다 (거래당 0.5% 추가 수수료).
 * 여기서는 보내고 서명만 받는다. 체결 수량·나간 SOL은 추정하지 않고 트랜잭션에서 읽는다 (solana-rpc.ts parseTxDeltas) —
 * Upbit live.ts 가 uuid로 체결을 확인하는 것과 같은 규율.
 */

export interface LivePolicy {
  /** 포지션당 상한 (SOL) */
  maxPositionSol: number;
  /** 열린 포지션 비용 합 상한 (SOL) */
  grossMaxSol: number;
  maxLots: number;
  slippagePct: number;
  priorityFeeSol: number;
  dailyStopPct: number;
  /** 실모드를 켜려면 지갑에 이만큼은 있어야 한다 */
  minWalletSol: number;
  /** 매수 뒤 지갑에 남겨 둘 SOL (수수료·매도 트랜잭션 비용) */
  reserveSol: number;
}
export const DEFAULT_LIVE_POLICY: LivePolicy = { maxPositionSol: 0.1, grossMaxSol: 1.0, maxLots: 5, slippagePct: 15, priorityFeeSol: 0.0005, dailyStopPct: 20, minWalletSol: 0.05, reserveSol: 0.02 };

export interface TradeRequest { action: "buy" | "sell"; mint: string; amount: number | string; denominatedInSol: boolean; slippage: number; priorityFee: number; pool: string }

const TRADE_URL = "https://pumpportal.fun/api/trade";

export async function lightningTrade(apiKey: string, req: TradeRequest): Promise<{ signature: string }> {
  if (!apiKey) throw new Error("no PUMPFUN_API_KEY");
  const body = { action: req.action, mint: req.mint, amount: req.amount, denominatedInSol: req.denominatedInSol ? "true" : "false", slippage: req.slippage, priorityFee: req.priorityFee, pool: req.pool, skipPreflight: "false" };
  const res = await fetch(`${TRADE_URL}?api-key=${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json: { signature?: string; errors?: unknown; error?: unknown } = {};
  try { json = JSON.parse(text) as typeof json; } catch { /* non-json */ }
  if (!res.ok) throw new Error(`pumpportal ${res.status}: ${text.slice(0, 200)}`);
  if (json.errors || json.error) throw new Error(`pumpportal refused: ${JSON.stringify(json.errors ?? json.error).slice(0, 200)}`);
  if (!json.signature || typeof json.signature !== "string") throw new Error(`pumpportal: no signature in response ${text.slice(0, 120)}`);
  logger.info("[pumpfun] live order sent", { action: req.action, mint: req.mint.slice(0, 8), amount: req.amount, pool: req.pool, signature: json.signature.slice(0, 12) });
  return { signature: json.signature };
}

/** 실매수 크기 — 페이퍼 규칙의 크기를 실돈 상한과 지갑 잔고로 다시 깎는다 */
export function liveBuySize(p: LivePolicy, wantSol: number, walletSol: number, openCostSol: number, openLots: number): { sol: number; why: string | null } {
  if (openLots >= p.maxLots) return { sol: 0, why: `live maxLots ${p.maxLots}` };
  let sol = Math.min(wantSol, p.maxPositionSol, p.grossMaxSol - openCostSol, walletSol - p.reserveSol - p.priorityFeeSol);
  sol = Math.floor(sol * 1e4) / 1e4;
  if (sol < 0.01) return { sol: 0, why: `live: no room (want ${wantSol.toFixed(3)}, gross ${(p.grossMaxSol - openCostSol).toFixed(3)}, wallet ${walletSol.toFixed(3)})` };
  return { sol, why: null };
}

export const isSolanaAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
