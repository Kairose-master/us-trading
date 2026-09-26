import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import type { TradeRequest } from "./live.js";

/**
 * 로컬 서명 실행 경로 — PUMPFUN_WALLET_SECRET 가 있으면 켜진다.
 *   • pump.fun 매매: PumpPortal Local API(/api/trade-local)가 직렬화된 트랜잭션을 주면 여기서 서명·전송한다.
 *     Lightning(0.5%)과 달리 우리가 키를 쥐고 서명하므로 그 수수료가 없다.
 *   • USDC→SOL 자동 스왑: Jupiter v6. 지갑에 SOL 이 부족하고 USDC 가 있으면 매수 직전에 필요한 만큼만 바꾼다.
 * 서명키는 Railway Secret 에만 두고 로그·API 응답에 절대 싣지 않는다(공개키만 노출).
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LOCAL_TRADE_URL = "https://pumpportal.fun/api/trade-local";
const JUP_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP = "https://quote-api.jup.ag/v6/swap";
const RPC_URL = config.PUMPFUN_RPC_URL || "https://api.mainnet-beta.solana.com";

let kp: Keypair | null = null;
let loaded = false;
function keypair(): Keypair | null {
  if (loaded) return kp;
  loaded = true;
  const s = config.PUMPFUN_WALLET_SECRET.trim();
  if (!s) return (kp = null);
  try {
    const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s) as number[]) : bs58.decode(s);
    kp = Keypair.fromSecretKey(bytes);
    logger.info("[pumpfun] local signer loaded", { pubkey: kp.publicKey.toBase58() });
  } catch (e) {
    logger.error("[pumpfun] PUMPFUN_WALLET_SECRET invalid — local signing disabled", { error: (e as Error).message });
    kp = null;
  }
  return kp;
}

let conn: Connection | null = null;
const connection = (): Connection => (conn ??= new Connection(RPC_URL, "confirmed"));

/** 로컬 서명이 가능한가(키가 로드됐나) */
export function hasSigner(): boolean { return keypair() !== null; }
/** 서명 지갑 공개키 — 화면·검증용(개인키는 절대 반환하지 않는다) */
export function signerPubkey(): string | null { const k = keypair(); return k ? k.publicKey.toBase58() : null; }

async function signSendSerialized(bytes: Uint8Array): Promise<string> {
  const k = keypair();
  if (!k) throw new Error("no local signer");
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([k]);
  return connection().sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
}

/** 로컬 서명 pump.fun 매매. Lightning 과 같은 반환 형태({signature}) — 호출부는 그대로 체인 대조로 체결 확정 */
export async function localTrade(req: TradeRequest): Promise<{ signature: string }> {
  const k = keypair();
  if (!k) throw new Error("no local signer (PUMPFUN_WALLET_SECRET)");
  const body = {
    publicKey: k.publicKey.toBase58(), action: req.action, mint: req.mint, amount: req.amount,
    denominatedInSol: req.denominatedInSol ? "true" : "false", slippage: req.slippage, priorityFee: req.priorityFee, pool: req.pool,
  };
  const res = await fetch(LOCAL_TRADE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`trade-local ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const signature = await signSendSerialized(buf);
  return { signature };
}

/** USDC→SOL 스왑(Jupiter). amountUsdc 는 UI 단위(6 decimals). 예상 산출 SOL 을 함께 반환 */
export async function swapUsdcToSol(amountUsdc: number, slippageBps = 100): Promise<{ signature: string; outSol: number }> {
  const k = keypair();
  if (!k) throw new Error("no local signer");
  const amount = Math.floor(amountUsdc * 1e6);
  if (amount <= 0) throw new Error("swap amount <= 0");
  const q = await fetch(`${JUP_QUOTE}?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${amount}&slippageBps=${slippageBps}&swapMode=ExactIn`, { signal: AbortSignal.timeout(12_000) });
  if (!q.ok) throw new Error(`jupiter quote ${q.status}: ${(await q.text()).slice(0, 160)}`);
  const quote = (await q.json()) as { outAmount?: string };
  if (!quote?.outAmount) throw new Error("jupiter: no route");
  const s = await fetch(JUP_SWAP, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: k.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!s.ok) throw new Error(`jupiter swap ${s.status}: ${(await s.text()).slice(0, 160)}`);
  const { swapTransaction } = (await s.json()) as { swapTransaction?: string };
  if (!swapTransaction) throw new Error("jupiter: no swapTransaction");
  const signature = await signSendSerialized(Buffer.from(swapTransaction, "base64"));
  return { signature, outSol: Number(quote.outAmount) / 1e9 };
}
