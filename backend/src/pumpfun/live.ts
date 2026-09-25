import { logger } from "../core/logger.js";

/**
 * pump.fun 실주문 — PumpPortal Lightning Transaction API. 돈이 나가는 유일한 경로.
 *   POST https://pumpportal.fun/api/trade?api-key=…  { action, mint, amount, denominatedInSol, slippage, priorityFee, pool }
 *   → { signature } 또는 { errors: [...] }. PumpPortal이 연결된 지갑으로 서명·전송한다 (거래당 0.5% 추가 수수료).
 * 여기서는 보내고 서명만 받는다. 체결 수량·나간 SOL은 추정하지 않고 트랜잭션에서 읽는다 (solana-rpc.ts parseTxDeltas) —
 * Upbit live.ts 가 uuid로 체결을 확인하는 것과 같은 규율.
 */

export interface LivePolicy {
  /** 포지션당 크기 = 실 에쿼티 × maxPositionPct% × standing — 고정 SOL이 아니라 지갑 전체를 기준으로 */
  maxPositionPct: number;
  /** 열린 포지션 비용 합 상한 (실 에쿼티 %) */
  grossMaxPct: number;
  /** 선택적 절대 상한 (SOL). 0이면 없음 */
  maxPositionSol: number;
  /** 동시 로트 수 상한. 0 = 제한 없음 — 크기는 이미 에쿼티 비율·총노출·지갑 예비로 잡혀 있어 개수 상한은 중복이다 (owner 지적) */
  maxLots: number;
  slippagePct: number;
  priorityFeeSol: number;
  dailyStopPct: number;
  /** 실모드를 켜려면 지갑에 이만큼은 있어야 한다 */
  minWalletSol: number;
  /** 지갑에 항상 남겨 둘 SOL (매도 트랜잭션 비용·데이터 요금) */
  reserveSol: number;
  /** 평가액이 이 아래인 로트는 팔지 않고 먼지로 지운다 — 수수료보다 싸다 (실측: 0.0007 SOL 짜리 매도가 시뮬레이션 실패로 219번 재시도됐다) */
  dustSol: number;
}
// 러그가 기본값인 시장 — 살아남는 건 손절이 아니라 크기다 (owner 합의, 2026-09-25 저녁). 포지션당 8% × standing(최대 16%), 총 60%, 일 손실 15%
export const DEFAULT_LIVE_POLICY: LivePolicy = { maxPositionPct: 8, grossMaxPct: 60, maxPositionSol: 0, maxLots: 0, slippagePct: 15, priorityFeeSol: 0.0005, dailyStopPct: 15, minWalletSol: 0.05, reserveSol: 0.02, dustSol: 0.003 };

export interface TradeRequest { action: "buy" | "sell"; mint: string; amount: number | string; denominatedInSol: boolean; slippage: number; priorityFee: number; pool: string }

const TRADE_URL = "https://pumpportal.fun/api/trade";

export async function lightningTrade(apiKey: string, req: TradeRequest): Promise<{ signature: string }> {
  if (!apiKey) throw new Error("no PUMPFUN_API_KEY");
  const body = { action: req.action, mint: req.mint, amount: req.amount, denominatedInSol: req.denominatedInSol ? "true" : "false", slippage: req.slippage, priorityFee: req.priorityFee, pool: req.pool, skipPreflight: "false" };
  const res = await fetch(`${TRADE_URL}?api-key=${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json: { signature?: string; errors?: unknown; error?: unknown } = {};
  try { json = JSON.parse(text) as typeof json; } catch { /* non-json */ }
  // 실측(2026-09-25 13:0x): 400 "Simulation failed" 응답에도 signature 가 실려 오고, 그 매도가 체인에서 체결된 경우가 있었다.
  // 그래서 signature 가 있으면 오류로 던지지 않고 돌려준다 — 체결 여부는 확정 조회·잔고 대조가 판단한다
  if (json.signature && typeof json.signature === "string") {
    if (!res.ok || json.errors || json.error) logger.warn("[pumpfun] pumpportal returned a signature with an error — will verify on-chain", { status: res.status, note: String(JSON.stringify(json.errors ?? json.error ?? "")).slice(0, 160) });
    return { signature: json.signature };
  }
  if (!res.ok) throw new Error(`pumpportal ${res.status}: ${text.slice(0, 200)}`);
  if (json.errors || json.error) throw new Error(`pumpportal refused: ${JSON.stringify(json.errors ?? json.error).slice(0, 200)}`);
  throw new Error(`pumpportal: no signature in response ${text.slice(0, 120)}`);
}

/** 실매수 크기 — 실 에쿼티(지갑 SOL + 실보유 평가) 비율 × standing. 총노출·지갑 예비·로트 수로 깎는다 */
export function liveBuySize(p: LivePolicy, equitySol: number, standing: number, walletSol: number, openCostSol: number, openLots: number): { sol: number; why: string | null } {
  if (p.maxLots > 0 && openLots >= p.maxLots) return { sol: 0, why: `live maxLots ${p.maxLots}` };
  let sol = equitySol * (p.maxPositionPct / 100) * Math.max(0, standing);
  if (p.maxPositionSol > 0) sol = Math.min(sol, p.maxPositionSol);
  const grossRoom = equitySol * (p.grossMaxPct / 100) - openCostSol;
  const walletRoom = walletSol - p.reserveSol - p.priorityFeeSol;
  sol = Math.min(sol, grossRoom, walletRoom);
  sol = Math.floor(sol * 1e4) / 1e4;
  if (sol < 0.01) return { sol: 0, why: `live: no room (size ${(equitySol * (p.maxPositionPct / 100) * standing).toFixed(3)}, gross ${grossRoom.toFixed(3)}, wallet ${walletRoom.toFixed(3)})` };
  return { sol, why: null };
}

export const isSolanaAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
