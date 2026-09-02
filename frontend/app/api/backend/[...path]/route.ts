import { NextResponse, type NextRequest } from "next/server"

/**
 * 대시보드 → 백엔드 프록시.
 * 서비스 토큰(BACKEND_TOKEN)은 서버 env에만 있고 브라우저로 나가지 않는다.
 * 사용자 세션은 httpOnly 쿠키(hs_session)에 있고, 여기서 X-Session 헤더로 옮겨 준다 —
 * 브라우저 JS는 세션 토큰을 볼 수 없다.
 *
 * 쓰기는 계정/금고 경로만 통과시킨다(로그인·가입·로그아웃·키 저장/삭제). 주문·자동매매
 * 토글·킬스위치는 여전히 백엔드 API에 직접 토큰으로 — 공개 대시보드에서 돈이 움직이지 않는다.
 * BACKEND_TOKEN이 없으면 503 BACKEND_NOT_CONFIGURED — 목데이터로 대체하지 않는다.
 */

export const dynamic = "force-dynamic"

const BASE = (process.env.BACKEND_URL ?? "https://us-trading-production.up.railway.app").replace(/\/$/, "")
const TOKEN = process.env.BACKEND_TOKEN
const COOKIE = "hs_session"

const ALLOW_GET: RegExp[] = [
  /^pipeline(\/nodes\/[^/]+|\/logs|\/targets|\/signals)?$/,
  /^sentiment(\/feed)?$/,
  /^autotrade$/,
  /^system\/status$/,
  /^account\/(balance|positions|holdings)$/,
  /^orders$/,
  /^quotes\/[^/]+(\/chart)?$/,
  /^risk\/limits$/,
  /^crypto\/(status|quotes|signals|paper\/equity|scanner(\/backtest)?|pipeline(\/nodes\/[^/]+|\/logs)?|sentiment(\/feed)?)$/,
  /^office\/(status|roster|runs(\/[^/]+)?)$/,
  /^auth\/(config|me)$/,
  /^keys$/,
  /^ops\/supervisor(\/logs)?$/,
]
const ALLOW_WRITE: Array<{ method: string; re: RegExp }> = [
  { method: "POST", re: /^auth\/(register|login|logout)$/ },
  { method: "PUT", re: /^keys\/(upbit|kis)$/ },
  { method: "DELETE", re: /^keys\/(upbit|kis)$/ },
  { method: "POST", re: /^ops\/supervisor\/(pause|resume|heal|auto-recovery|[A-Za-z0-9_-]+\/break)$/ },
]

async function forward(req: NextRequest, rel: string, method: string, body?: string) {
  const session = req.cookies.get(COOKIE)?.value
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
  if (session) headers["X-Session"] = session
  if (body !== undefined) headers["content-type"] = "application/json"
  const res = await fetch(`${BASE}/api/${rel}${req.nextUrl.search}`, { method, headers, body, cache: "no-store", signal: AbortSignal.timeout(170_000) })
  const text = await res.text()
  return { res, text }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params
  const rel = path.join("/")
  if (!TOKEN) return NextResponse.json({ error: "backend not configured", code: "BACKEND_NOT_CONFIGURED" }, { status: 503 })
  if (!ALLOW_GET.some((re) => re.test(rel))) return NextResponse.json({ error: `not proxied: ${rel}` }, { status: 404 })
  try {
    const { res, text } = await forward(req, rel, "GET")
    return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } })
  } catch (e) {
    return NextResponse.json({ error: `backend unreachable: ${(e as Error).message}`, code: "BACKEND_UNREACHABLE" }, { status: 502 })
  }
}

async function write(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }, method: string) {
  const { path } = await ctx.params
  const rel = path.join("/")
  if (!TOKEN) return NextResponse.json({ error: "backend not configured", code: "BACKEND_NOT_CONFIGURED" }, { status: 503 })
  if (!ALLOW_WRITE.some((w) => w.method === method && w.re.test(rel))) {
    return NextResponse.json({ error: "공개 대시보드는 계정·금고 외 쓰기를 통과시키지 않습니다 — 주문/토글은 백엔드 API에 직접 토큰으로", code: "READ_ONLY" }, { status: 405 })
  }
  try {
    const body = method === "DELETE" ? undefined : await req.text()
    const { res, text } = await forward(req, rel, method, body)
    // 로그인/가입: 토큰은 httpOnly 쿠키로만 내려간다 — 본문에서 제거
    if (/^auth\/(login|register)$/.test(rel) && res.ok) {
      const j = JSON.parse(text) as { token?: string; user?: unknown }
      const out = NextResponse.json({ user: j.user })
      if (j.token) out.cookies.set(COOKIE, j.token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 })
      return out
    }
    if (rel === "auth/logout") {
      const out = NextResponse.json({ ok: true })
      out.cookies.set(COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 })
      return out
    }
    return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } })
  } catch (e) {
    return NextResponse.json({ error: `backend unreachable: ${(e as Error).message}`, code: "BACKEND_UNREACHABLE" }, { status: 502 })
  }
}

export const POST = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => write(req, ctx, "POST")
export const PUT = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => write(req, ctx, "PUT")
export const PATCH = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => write(req, ctx, "PATCH")
export const DELETE = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => write(req, ctx, "DELETE")
