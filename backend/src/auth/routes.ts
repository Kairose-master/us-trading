import { Router, type NextFunction, type Request, type Response } from "express";
import { authStore, type Provider, type User } from "./store.js";
import { credentialSources } from "./credentials.js";
import { config } from "../config.js";

/**
 * /api/auth/* 와 /api/keys/* — 세션은 X-Session 헤더(프론트 프록시가 httpOnly 쿠키에서
 * 옮겨 준다). 전역 API_AUTH_TOKEN 베어러는 그대로 필요하다(서비스 간 인증).
 */
export interface AuthedRequest extends Request {
  user?: User;
}

export function requireSession(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.header("x-session") ?? undefined;
  const u = authStore.userForToken(token);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다", code: "NO_SESSION" });
  req.user = u;
  next();
}

// 로그인 시도 제한 — IP당 10분에 20회
const attempts = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now();
  const arr = (attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  arr.push(now);
  attempts.set(ip, arr);
  return arr.length > 20;
}

export const authRouter = Router();

authRouter.get("/auth/config", (_req, res) => {
  res.json({ users: authStore.userCount(), signupOpen: config.SIGNUP_OPEN === "true" || authStore.userCount() === 0, vaultUnlocked: authStore.vaultUnlocked() });
});

authRouter.post("/auth/register", (req, res) => {
  if (throttled(req.ip ?? "?")) return res.status(429).json({ error: "잠시 후 다시 시도하세요" });
  const open = config.SIGNUP_OPEN === "true" || authStore.userCount() === 0;
  if (!open) return res.status(403).json({ error: "가입이 닫혀 있습니다 (SIGNUP_OPEN=true로 열 수 있음)" });
  try {
    const u = authStore.register(String(req.body?.email ?? ""), String(req.body?.password ?? ""));
    const s = authStore.login(u.email, String(req.body?.password ?? ""))!;
    res.json({ token: s.token, user: authStore.publicUser(u) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

authRouter.post("/auth/login", (req, res) => {
  if (throttled(req.ip ?? "?")) return res.status(429).json({ error: "잠시 후 다시 시도하세요" });
  const s = authStore.login(String(req.body?.email ?? ""), String(req.body?.password ?? ""));
  if (!s) return res.status(401).json({ error: "이메일 또는 비밀번호가 틀립니다" });
  res.json({ token: s.token, user: authStore.publicUser(s.user) });
});

authRouter.post("/auth/logout", (req, res) => {
  const token = req.header("x-session");
  if (token) authStore.logout(token);
  res.json({ ok: true });
});

authRouter.get("/auth/me", requireSession, (req: AuthedRequest, res) => {
  res.json({ user: authStore.publicUser(req.user!), credentials: credentialSources() });
});

const PROVIDER_FIELDS: Record<Provider, string[]> = {
  upbit: ["accessKey", "secretKey"],
  kis: ["appKey", "appSecret", "accountNo"],
};

authRouter.get("/keys", requireSession, (req: AuthedRequest, res) => {
  res.json({ vaultUnlocked: authStore.vaultUnlocked(), keys: authStore.maskedKeys(req.user!.id), sources: credentialSources() });
});

authRouter.put("/keys/:provider", requireSession, (req: AuthedRequest, res) => {
  const provider = req.params.provider as Provider;
  const fields = PROVIDER_FIELDS[provider];
  if (!fields) return res.status(404).json({ error: "알 수 없는 공급자" });
  if (!authStore.vaultUnlocked()) return res.status(503).json({ error: "금고가 잠겨 있습니다 — 서버에 CREDENTIALS_MASTER_KEY를 설정하세요", code: "VAULT_LOCKED" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const keys: Record<string, string> = {};
  for (const f of fields) if (typeof body[f] === "string") keys[f] = body[f] as string;
  try {
    authStore.putKeys(req.user!.id, provider, keys);
    res.json({ ok: true, keys: authStore.maskedKeys(req.user!.id) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

authRouter.delete("/keys/:provider", requireSession, (req: AuthedRequest, res) => {
  const provider = req.params.provider as Provider;
  if (!PROVIDER_FIELDS[provider]) return res.status(404).json({ error: "알 수 없는 공급자" });
  authStore.deleteKeys(req.user!.id, provider);
  res.json({ ok: true, keys: authStore.maskedKeys(req.user!.id) });
});
