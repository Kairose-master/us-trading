"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { KeyRound } from "lucide-react"
import { ApiError, getAuthConfig, isBackendNotConfigured, login, register } from "@/lib/api"
import { Card, EmptyState } from "@/components/primitives"
import { cn } from "@/lib/utils"

export function LoginClient() {
  const router = useRouter()
  const { data: cfg, error } = useSWR("auth-config", getAuthConfig)
  const [mode, setMode] = useState<"login" | "register">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  if (isBackendNotConfigured(error)) {
    return (
      <Card className="mx-auto mt-10 max-w-md p-4">
        <EmptyState title="백엔드 미연결" hint="Vercel 환경변수 BACKEND_TOKEN이 있어야 로그인할 수 있습니다." />
      </Card>
    )
  }
  const signupOpen = cfg?.signupOpen ?? false

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      if (mode === "register") await register(email, password)
      else await login(email, password)
      router.push("/settings")
      router.refresh()
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "실패")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto mt-10 flex w-full max-w-md flex-col gap-4">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-lg font-bold">{mode === "register" ? "계정 만들기" : "로그인"}</h1>
      </div>
      <Card className="flex flex-col gap-3 p-4">
        {cfg && cfg.users === 0 && (
          <p className="rounded-md bg-chart-1/10 px-3 py-2 text-[11px] text-chart-1">아직 계정이 없습니다. 첫 계정이 이 서버의 <b>owner</b>가 되고, 그 사람의 거래소 키로 엔진이 돕니다.</p>
        )}
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">이메일</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required autoComplete="email" className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">비밀번호 {mode === "register" && "(8자 이상)"}</span>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={8} autoComplete={mode === "register" ? "new-password" : "current-password"} className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm" />
          </label>
          {msg && <p className="text-xs text-destructive">{msg}</p>}
          <button type="submit" disabled={busy} className={cn("rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-opacity", busy && "opacity-60")}>
            {busy ? "…" : mode === "register" ? "가입하고 로그인" : "로그인"}
          </button>
        </form>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          {mode === "login" ? (
            signupOpen ? <button type="button" className="underline" onClick={() => setMode("register")}>계정 만들기</button> : <span>가입 닫힘 (SIGNUP_OPEN)</span>
          ) : (
            <button type="button" className="underline" onClick={() => setMode("login")}>이미 계정이 있음</button>
          )}
          <span>{cfg?.vaultUnlocked ? "금고 열림" : "금고 잠김 — CREDENTIALS_MASTER_KEY 필요"}</span>
        </div>
      </Card>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        세션은 httpOnly 쿠키로만 저장되고, 거래소 키는 서버에서 AES-256-GCM으로 암호화해 볼륨에 둡니다. 브라우저에는 키가 남지 않습니다. 자세한 건 docs/accounts.md.
      </p>
    </div>
  )
}
