import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../core/logger.js";
import { hashPassword, newToken, open, seal, sha256Hex, verifyPassword, vaultKey, type Sealed } from "./crypto.js";

/**
 * 계정·세션·금고 — 볼륨(data/)의 JSON 파일 두 개. 원자적 쓰기(tmp → rename).
 *   data/auth.json  : users(비밀번호는 scrypt 해시), sessions(토큰은 sha256만 저장)
 *   data/vault.json : 사용자별·공급자별 AES-GCM 암호문 — 평문 키는 디스크에 없다
 *
 * 첫 가입자가 owner. 거래 엔진(Upbit/KIS 데스크)은 owner의 키를 쓴다 —
 * 사용자별 데스크 분리는 다음 단계(docs/accounts.md).
 */

export type Provider = "upbit" | "kis";
export interface User {
  id: string;
  email: string;
  role: "owner" | "member";
  salt: string;
  hash: string;
  createdAt: string;
}
interface Session {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}
interface AuthFile {
  users: User[];
  sessions: Session[];
}
interface VaultFile {
  records: Record<string, Sealed & { updatedAt: string; last4: Record<string, string> }>; // key = `${userId}:${provider}`
}

const AUTH_FILE = join(process.cwd(), "data", "auth.json");
const VAULT_FILE = join(process.cwd(), "data", "vault.json");
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

function readJson<T>(p: string, fallback: T): T {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as T) : fallback;
  } catch (e) {
    logger.warn("auth 파일 읽기 실패 — 빈 상태로", { file: p, error: (e as Error).message });
    return fallback;
  }
}
function writeJson(p: string, v: unknown) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  renameSync(tmp, p);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class AuthStore {
  private auth: AuthFile = readJson<AuthFile>(AUTH_FILE, { users: [], sessions: [] });
  private vault: VaultFile = readJson<VaultFile>(VAULT_FILE, { records: {} });
  private plainCache = new Map<string, Record<string, string>>();

  vaultUnlocked(): boolean {
    return vaultKey() !== null;
  }
  userCount(): number {
    return this.auth.users.length;
  }
  owner(): User | null {
    return this.auth.users.find((u) => u.role === "owner") ?? null;
  }
  publicUser(u: User) {
    return { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt };
  }

  register(email: string, password: string): User {
    email = email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error("이메일 형식이 아닙니다");
    if (password.length < 8) throw new Error("비밀번호는 8자 이상");
    if (this.auth.users.some((u) => u.email === email)) throw new Error("이미 가입된 이메일");
    const { salt, hash } = hashPassword(password);
    const user: User = { id: `u_${newToken().slice(0, 16)}`, email, role: this.auth.users.length === 0 ? "owner" : "member", salt, hash, createdAt: new Date().toISOString() };
    this.auth.users.push(user);
    writeJson(AUTH_FILE, this.auth);
    logger.info("계정 생성", { email, role: user.role });
    return user;
  }

  login(email: string, password: string): { token: string; user: User } | null {
    const u = this.auth.users.find((x) => x.email === email.trim().toLowerCase());
    // 사용자 없음도 같은 비용으로 — 타이밍으로 가입 여부를 못 알아내게
    const ok = u ? verifyPassword(password, u.salt, u.hash) : (verifyPassword(password, "00", "00"), false);
    if (!u || !ok) return null;
    const token = newToken();
    const now = Date.now();
    this.auth.sessions = this.auth.sessions.filter((s) => Date.parse(s.expiresAt) > now);
    this.auth.sessions.push({ tokenHash: sha256Hex(token), userId: u.id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL_MS).toISOString() });
    writeJson(AUTH_FILE, this.auth);
    return { token, user: u };
  }

  logout(token: string) {
    const h = sha256Hex(token);
    this.auth.sessions = this.auth.sessions.filter((s) => s.tokenHash !== h);
    writeJson(AUTH_FILE, this.auth);
  }

  userForToken(token: string | undefined): User | null {
    if (!token) return null;
    const h = sha256Hex(token);
    const s = this.auth.sessions.find((x) => x.tokenHash === h);
    if (!s || Date.parse(s.expiresAt) < Date.now()) return null;
    return this.auth.users.find((u) => u.id === s.userId) ?? null;
  }

  // ===== 금고 =====

  putKeys(userId: string, provider: Provider, keys: Record<string, string>) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) if (typeof v === "string" && v.trim()) clean[k] = v.trim();
    if (Object.keys(clean).length === 0) throw new Error("저장할 키가 없습니다");
    const id = `${userId}:${provider}`;
    const last4: Record<string, string> = {};
    for (const [k, v] of Object.entries(clean)) last4[k] = v.slice(-4);
    this.vault.records[id] = { ...seal(clean, id), updatedAt: new Date().toISOString(), last4 };
    writeJson(VAULT_FILE, this.vault);
    this.plainCache.delete(id);
    logger.info("자격증명 저장(암호화)", { userId, provider, fields: Object.keys(clean) });
  }

  deleteKeys(userId: string, provider: Provider) {
    const id = `${userId}:${provider}`;
    delete this.vault.records[id];
    writeJson(VAULT_FILE, this.vault);
    this.plainCache.delete(id);
  }

  /** 화면용 — 끝 4자리만 */
  maskedKeys(userId: string): Record<Provider, { updatedAt: string; last4: Record<string, string> } | null> {
    const pick = (p: Provider) => {
      const r = this.vault.records[`${userId}:${p}`];
      return r ? { updatedAt: r.updatedAt, last4: r.last4 } : null;
    };
    return { upbit: pick("upbit"), kis: pick("kis") };
  }

  /** 엔진용 — 복호화된 평문 (메모리 캐시) */
  keys(userId: string, provider: Provider): Record<string, string> | null {
    const id = `${userId}:${provider}`;
    const cached = this.plainCache.get(id);
    if (cached) return cached;
    const r = this.vault.records[id];
    if (!r) return null;
    try {
      const plain = open<Record<string, string>>(r, id);
      this.plainCache.set(id, plain);
      return plain;
    } catch (e) {
      logger.warn("자격증명 복호화 실패 — 마스터 키가 바뀌었나?", { id, error: (e as Error).message });
      return null;
    }
  }
}

export const authStore = new AuthStore();
