import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";

/**
 * SCAM 발행 — "Smart Contract Attack Museum". 우리가 만드는 유일한 코인이고 규칙은 하나다: **정직한 버전만**.
 *   · creator 물량 0 (dev buy 는 상한 0.05 SOL — 수수료 몫), 번들 없음, 볼륨 조작 없음
 *   · 메타데이터에 봇이 만든 밈코인임과 TRUST404 아카이브(취약 컨트랙트 12개 + 자동 익스플로잇 증명)를 공개
 *   · 우리 봇은 이 mint 를 절대 사고팔지 않는다 (isOwnMint — 카피·복합·커뮤니티 전부 차단)
 *   · 수입은 pump.fun creator 수수료뿐이고, 그건 진짜 거래량이 있어야 나온다
 * 발행은 화면에서 owner 가 "LAUNCH" 를 타이핑해야만 나간다 (PumpPortal Lightning action:"create").
 * 메타데이터 URI: PINATA_JWT 가 있으면 Pinata IPFS, 없으면 대시보드 정적 파일(/scam/metadata.json).
 */

const DIR = join(process.cwd(), "data", "pumpfun");
const FILE = join(DIR, "launch.json");
const TRADE_URL = "https://pumpportal.fun/api/trade";
export const MAX_DEV_BUY_SOL = 0.05;

export interface LaunchMeta { name: string; symbol: string; description: string; twitter: string; telegram: string; website: string; image: string }
export const DEFAULT_META: LaunchMeta = {
  name: "SCAM",
  symbol: "SCAM",
  description: "Smart Contract Attack Museum. Every scam contract we could prove exploitable, archived with its proof-of-concept — reentrancy, open vaults, bad accounting, naive oracles, delegatecall hijacks, weak randomness, open initializers. Launched by a trading bot as an honest meme: creator holds 0 (launch buy burned), no bundle, no fake volume, and the bot never trades this coin. No intrinsic value. Can go to zero. Museum: scam-museum.vercel.app",
  twitter: "",
  telegram: "",
  website: config.SCAM_SITE_URL,
  image: `${config.SCAM_SITE_URL}/assets/scam.png`,
};

export interface LaunchRecord { mint: string; signature: string; ts: string; by: string; devBuySol: number; uri: string; meta: LaunchMeta }
export interface LaunchState { launched: LaunchRecord | null; attempts: Array<{ ts: string; ok: boolean; note: string }> }

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (const b of bytes) { let carry = b; for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; } while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; } }
  let out = ""; for (let i = 0; i < zeros; i++) out += "1"; for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** ed25519 키쌍 → Solana 형식 (secretKey 64B = seed ‖ pubkey) */
export function newMintKeypair(): { publicKey: string; secretKeyB58: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer; // 마지막 32B 가 seed
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer; // 마지막 32B 가 pubkey
  const seed = pkcs8.subarray(pkcs8.length - 32), pub = spki.subarray(spki.length - 32);
  return { publicKey: base58(pub), secretKeyB58: base58(Buffer.concat([seed, pub])) };
}

/** "…pump" 접미사 그라인딩 — 시간 상한 안에서만 (없어도 발행에는 문제 없다) */
export function grindPumpSuffix(maxMs = 20_000): { publicKey: string; secretKeyB58: string; tries: number } {
  const t0 = Date.now(); let tries = 0;
  for (;;) { const k = newMintKeypair(); tries++; if (k.publicKey.endsWith("pump")) return { ...k, tries }; if (Date.now() - t0 > maxMs) return { ...k, tries }; }
}

export class LaunchDesk {
  private st: LaunchState = { launched: null, attempts: [] };
  constructor() { try { if (existsSync(FILE)) this.st = JSON.parse(readFileSync(FILE, "utf-8")) as LaunchState; } catch (e) { logger.warn("[pumpfun] launch state restore failed", { error: (e as Error).message }); } }
  private save() { try { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(this.st, null, 1)); } catch (e) { logger.warn("[pumpfun] launch save failed", { error: (e as Error).message }); } }
  status() { return { ...this.st, defaults: DEFAULT_META, maxDevBuySol: MAX_DEV_BUY_SOL, pinata: !!config.PINATA_JWT, metadataUri: this.metadataUri(), imageUrl: DEFAULT_META.image }; }
  isOwnMint(mint: string) { return !!this.st.launched && this.st.launched.mint === mint; }
  ownMint() { return this.st.launched?.mint ?? null; }

  metadataJson(meta: LaunchMeta) { return { name: meta.name, symbol: meta.symbol, description: meta.description, image: meta.image, showName: true, createdOn: "https://pump.fun", twitter: meta.twitter || undefined, telegram: meta.telegram || undefined, website: meta.website || undefined }; }
  private metadataUri() { return `${config.SCAM_SITE_URL}/metadata.json`; }

  /** Pinata 가 있으면 IPFS 에 올린다. 없으면 대시보드 정적 파일 URI */
  async uploadMetadata(meta: LaunchMeta): Promise<{ uri: string; via: "pinata" | "dashboard" }> {
    if (!config.PINATA_JWT) return { uri: this.metadataUri(), via: "dashboard" };
    const body = JSON.stringify({ pinataContent: this.metadataJson(meta), pinataMetadata: { name: `${meta.symbol}-metadata.json` } });
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.PINATA_JWT}` }, body, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`pinata ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = (await res.json()) as { IpfsHash: string };
    return { uri: `https://ipfs.io/ipfs/${j.IpfsHash}`, via: "pinata" };
  }

  /** 실제 발행 — owner 가 LAUNCH 를 타이핑했을 때만 라우트가 부른다 */
  async launch(p: { meta: LaunchMeta; devBuySol: number; by: string; slippagePct?: number; priorityFeeSol?: number }): Promise<LaunchRecord> {
    if (this.st.launched) throw new Error(`already launched: ${this.st.launched.mint}`);
    if (!config.PUMPFUN_API_KEY) throw new Error("PUMPFUN_API_KEY 없음");
    const devBuy = Math.max(0, Math.min(MAX_DEV_BUY_SOL, Number(p.devBuySol) || 0));
    const meta = { ...DEFAULT_META, ...p.meta, name: (p.meta.name || "SCAM").slice(0, 32), symbol: (p.meta.symbol || "SCAM").slice(0, 10) };
    const { uri, via } = await this.uploadMetadata(meta);
    const kp = grindPumpSuffix(15_000);
    const body = { action: "create", tokenMetadata: { name: meta.name, symbol: meta.symbol, uri }, mint: kp.secretKeyB58, denominatedInSol: "true", amount: devBuy, slippage: p.slippagePct ?? 10, priorityFee: p.priorityFeeSol ?? 0.0005, pool: "pump" };
    const res = await fetch(`${TRADE_URL}?api-key=${encodeURIComponent(config.PUMPFUN_API_KEY)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await res.text(); let j: { signature?: string; errors?: unknown; error?: unknown } = {}; try { j = JSON.parse(text) as typeof j; } catch { /* non-json */ }
    if (!res.ok || !j.signature) { this.st.attempts.push({ ts: new Date().toISOString(), ok: false, note: `${res.status} ${text.slice(0, 200)}` }); this.save(); throw new Error(`pumpportal create ${res.status}: ${text.slice(0, 200)}`); }
    const rec: LaunchRecord = { mint: kp.publicKey, signature: j.signature, ts: new Date().toISOString(), by: p.by, devBuySol: devBuy, uri, meta };
    this.st.launched = rec; this.st.attempts.push({ ts: rec.ts, ok: true, note: `mint ${rec.mint} via ${via}, grind tries ${kp.tries}` }); this.save();
    logger.warn("[pumpfun] TOKEN LAUNCHED", { mint: rec.mint, signature: rec.signature, devBuy, uri });
    return rec;
  }
}
export const launchDesk = new LaunchDesk();
