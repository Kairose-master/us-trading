"use client"

import { useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { LogOut, ShieldCheck, Trash2 } from "lucide-react"
import { ApiError, authMe, deleteKeys, getKeys, isBackendNotConfigured, logout, putKeys, type MaskedKeys } from "@/lib/api"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { cn } from "@/lib/utils"

type Provider = "upbit" | "kis"
const FIELDS: Record<Provider, Array<{ key: string; label: string; secret?: boolean }>> = {
  upbit: [
    { key: "accessKey", label: "Access Key" },
    { key: "secretKey", label: "Secret Key", secret: true },
  ],
  kis: [
    { key: "appKey", label: "App Key" },
    { key: "appSecret", label: "App Secret", secret: true },
    { key: "accountNo", label: "계좌번호 (12345678-01)" },
  ],
}

function KeyForm({ provider, title, hint, masked, onSaved }: { provider: Provider; title: string; hint: string; masked: MaskedKeys[Provider]; onSaved: (k: MaskedKeys) => void }) {
  const [vals, setVals] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await putKeys(provider, vals)
      onSaved(r.keys)
      setVals({})
      toast.success(`${title} 키를 암호화해 저장했습니다`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "저장 실패")
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!confirm(`${title} 키를 삭제할까요?`)) return
    try {
      const r = await deleteKeys(provider)
      onSaved(r.keys)
      toast.success("삭제됨")
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "삭제 실패")
    }
  }
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {masked ? (
          <span className="rounded-sm bg-chart-1/15 px-1.5 py-0.5 font-mono text-[10px] text-chart-1">저장됨 · {new Date(masked.updatedAt).toLocaleString("ko-KR", { hour12: false })}</span>
        ) : (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">미등록</span>
        )}
        {masked && (
          <button type="button" onClick={remove} className="ml-auto flex items-center gap-1 text-[11px] text-destructive hover:underline">
            <Trash2 className="size-3" aria-hidden="true" /> 삭제
          </button>
        )}
      </div>
      <form onSubmit={save} className="flex flex-col gap-3 p-4">
        <p className="text-[11px] text-muted-foreground">{hint}</p>
        {FIELDS[provider].map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              {f.label}
              {masked?.last4[f.key] && <span className="ml-2 font-mono text-[10px]">저장값 ····{masked.last4[f.key]}</span>}
            </span>
            <input
              value={vals[f.key] ?? ""}
              onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              placeholder={masked ? "바꾸려면 새 값 입력" : ""}
              className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            />
          </label>
        ))}
        <button type="submit" disabled={busy} className={cn("self-start rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground", busy && "opacity-60")}>
          {busy ? "…" : "암호화해 저장"}
        </button>
      </form>
    </Card>
  )
}

export function SettingsClient() {
  const { data: me, error, mutate: mutateMe } = useSWR("auth-me", authMe, { shouldRetryOnError: false })
  const { data: keys, mutate: mutateKeys } = useSWR(me ? "keys" : null, getKeys)

  if (isBackendNotConfigured(error)) {
    return (
      <Card className="p-4">
        <EmptyState title="백엔드 미연결" hint="Vercel 환경변수 BACKEND_TOKEN이 있어야 설정을 쓸 수 있습니다." />
      </Card>
    )
  }
  if (error instanceof ApiError && (error.status === 401 || error.code === "NO_SESSION")) {
    return (
      <Card className="p-6">
        <EmptyState title="로그인이 필요합니다" hint="키는 로그인한 계정의 금고에만 저장됩니다." />
        <div className="mt-3 text-center">
          <Link href="/login" className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">로그인</Link>
        </div>
      </Card>
    )
  }
  if (!me) return <Skeleton className="h-64 w-full" />

  const onLogout = async () => {
    await logout()
    mutateMe(undefined, { revalidate: true })
    location.href = "/login"
  }
  const onSaved = (k: MaskedKeys) => {
    mutateKeys((prev) => (prev ? { ...prev, keys: k } : prev), { revalidate: true })
    mutateMe()
  }
  const src = me.credentials

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-3 p-4 text-xs">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="font-mono">{me.user.email}</span>
        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px]">{me.user.role}</span>
        <span className="text-muted-foreground">
          엔진이 쓰는 키: Upbit {src.upbit ?? "없음"} · KIS {src.kis ?? "없음"} {src.owner && `(owner ${src.owner})`}
        </span>
        <span className={cn("ml-auto font-mono text-[10px]", src.vaultUnlocked ? "text-chart-1" : "text-destructive")}>{src.vaultUnlocked ? "금고 열림 (AES-256-GCM)" : "금고 잠김 — CREDENTIALS_MASTER_KEY 미설정"}</span>
        <button type="button" onClick={onLogout} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <LogOut className="size-3" aria-hidden="true" /> 로그아웃
        </button>
      </Card>
      {!src.vaultUnlocked && (
        <Card className="p-3 text-[11px] text-destructive">서버 환경변수 CREDENTIALS_MASTER_KEY(openssl rand -hex 32)가 없어 키를 저장할 수 없습니다. Railway Variables에 넣으면 바로 열립니다.</Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <KeyForm provider="upbit" title="Upbit Open API" hint="업비트 마이페이지 → Open API 관리에서 발급. 자산조회·주문 권한이 있어야 실주문이 되고, 실주문은 서버의 CRYPTO_TRADE_ALLOW_REAL=true까지 있어야 켜집니다. 시세·백테스트·페이퍼는 키 없이도 돕니다." masked={keys?.keys.upbit ?? null} onSaved={onSaved} />
        <KeyForm provider="kis" title="한국투자증권 KIS Open API" hint="KIS Developers에서 실전/모의 키를 따로 발급. 서버의 KIS_MODE(mock/real)와 맞는 키를 넣으세요. MOCK_DATA=false로 바꿔야 실계좌 보유가 붙습니다." masked={keys?.keys.kis ?? null} onSaved={onSaved} />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        환경변수에 키가 있으면 그것이 우선이고(표시: env), 없으면 owner 계정의 금고(vault)를 씁니다. 지금 거래 엔진은 서버당 하나라 owner의 키만 쓰입니다 — 사용자별 데스크 분리는 docs/accounts.md의 다음 단계입니다.
      </p>
    </div>
  )
}
