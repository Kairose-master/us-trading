import { NextResponse, type NextRequest } from "next/server"

/**
 * 대시보드 → 백엔드 읽기 전용 프록시.
 * 토큰(BACKEND_TOKEN)은 서버 env에만 있고 브라우저로 나가지 않는다.
 * 공개 배포된 대시보드라 쓰기(POST/PATCH/DELETE)는 통과시키지 않는다 —
 * 주문·자동매매 토글·킬스위치는 백엔드 API에 직접 토큰으로.
 * BACKEND_TOKEN이 없으면 503 BACKEND_NOT_CONFIGURED — 프론트는 목데이터로
 * 대체하지 않고 "미연결"을 그대로 보여준다.
 */

export const dynamic = "force-dynamic"

const BASE = (process.env.BACKEND_URL ?? "https://us-trading-production.up.railway.app").replace(/\/$/, "")
const TOKEN = process.env.BACKEND_TOKEN

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
  /^office\/(status|runs(\/[^/]+)?)$/,
]

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params
  const rel = path.join("/")
  if (!TOKEN) {
    return NextResponse.json({ error: "backend not configured", code: "BACKEND_NOT_CONFIGURED" }, { status: 503 })
  }
  if (!ALLOW_GET.some((re) => re.test(rel))) {
    return NextResponse.json({ error: `not proxied: ${rel}` }, { status: 404 })
  }
  const url = `${BASE}/api/${rel}${req.nextUrl.search}`
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store", signal: AbortSignal.timeout(170_000) })
    const text = await res.text()
    return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } })
  } catch (e) {
    return NextResponse.json({ error: `backend unreachable: ${(e as Error).message}`, code: "BACKEND_UNREACHABLE" }, { status: 502 })
  }
}

const READ_ONLY = () =>
  NextResponse.json({ error: "공개 대시보드는 읽기 전용 — 쓰기는 백엔드 API에 직접 토큰으로 호출", code: "READ_ONLY" }, { status: 405 })
export const POST = READ_ONLY
export const PATCH = READ_ONLY
export const DELETE = READ_ONLY
