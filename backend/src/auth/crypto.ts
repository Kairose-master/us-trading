import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../core/logger.js";

/**
 * 마스터 키 출처 (우선순위):
 *   1) CREDENTIALS_MASTER_KEY 환경변수 — 있으면 그대로 (볼륨과 분리된 키 = 더 강한 모델)
 *   2) data/vault-master.key — 없으면 첫 기동 때 32바이트를 생성해 0600으로 저장한다.
 * 2)는 암호문(vault.json)과 같은 볼륨에 키가 놓이므로 볼륨 자체가 유출되면 같이 열린다.
 * 대신 설정 없이 바로 쓸 수 있다. 이 파일을 지우면 기존 암호문은 못 연다 — 키를 다시 등록해야 한다.
 */
const KEY_FILE = join(process.cwd(), "data", "vault-master.key");

function fileMasterKey(): Buffer | null {
  try {
    if (existsSync(KEY_FILE)) {
      const hex = readFileSync(KEY_FILE, "utf-8").trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
      logger.error("금고 키 파일이 손상됨 — 금고 잠김 (파일을 지우면 새 키가 생성되지만 기존 암호문은 못 연다)", { file: KEY_FILE });
      return null;
    }
    const key = randomBytes(32);
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    const tmp = `${KEY_FILE}.tmp`;
    writeFileSync(tmp, key.toString("hex") + "\n", { mode: 0o600 });
    renameSync(tmp, KEY_FILE);
    logger.warn("금고 마스터 키를 새로 생성해 볼륨에 저장 — 볼륨이 없으면 재배포마다 바뀌어 저장한 거래소 키를 못 연다", { file: KEY_FILE });
    return key;
  } catch (e) {
    logger.error("금고 키 파일 생성/읽기 실패 — 금고 잠김", { file: KEY_FILE, error: (e as Error).message });
    return null;
  }
}

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
  if (!raw) return (masterKey = fileMasterKey());
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
  if (!key) throw new Error("VAULT_LOCKED: 금고 키를 만들 수 없음 (data/ 쓰기 실패 또는 키 파일 손상) — 서버 로그 확인");
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
