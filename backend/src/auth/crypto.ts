import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * 비밀번호 해시(scrypt) + 자격증명 금고(AES-256-GCM).
 *
 * 금고 마스터 키는 CREDENTIALS_MASTER_KEY 하나에서 나온다 — 64자리 hex면 그대로
 * 32바이트 키, 아니면 scrypt로 32바이트를 유도한다. 이 값이 없으면 금고는 잠긴다
 * (키 저장 API가 503). 레코드마다 12바이트 IV가 새로 나오고 AAD에 `${userId}:${provider}`를
 * 묶어 두어, 다른 사용자/공급자 자리에 옮겨 붙인 암호문은 복호화되지 않는다.
 */

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const h = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expect = Buffer.from(hash, "hex");
  return h.length === expect.length && timingSafeEqual(h, expect);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

let masterKey: Buffer | null | undefined;
export function vaultKey(): Buffer | null {
  if (masterKey !== undefined) return masterKey;
  const raw = config.CREDENTIALS_MASTER_KEY;
  if (!raw) return (masterKey = null);
  masterKey = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : scryptSync(raw, "us-trading-vault-v1", 32, { N: 16384, r: 8, p: 1 });
  return masterKey;
}

export interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export function seal(obj: unknown, aad: string): Sealed {
  const key = vaultKey();
  if (!key) throw new Error("VAULT_LOCKED: CREDENTIALS_MASTER_KEY 미설정");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function open<T = unknown>(s: Sealed, aad: string): T {
  const key = vaultKey();
  if (!key) throw new Error("VAULT_LOCKED: CREDENTIALS_MASTER_KEY 미설정");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  const pt = Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}
