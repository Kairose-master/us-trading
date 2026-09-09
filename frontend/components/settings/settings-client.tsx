"use client"

import { useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { AlertTriangle, LogOut, ShieldCheck, Trash2 } from "lucide-react"
import { ApiError, authMe, deleteKeys, getKeys, getLivePreview, getTradingMode, isBackendNotConfigured, logout, putKeys, setTradingMode, type MaskedKeys } from "@/lib/api"
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

const krw = (n: number | null | undefined) => (typeof n === "number" ? `₩${Math.round(n).toLocaleString("ko-KR")}` : "—")

/**
 * 거래 모드 스위치 — paper ↔ real. owner만. real로 켤 때는 "REAL"을 타이핑해야 하고,
 * 백엔드가 Upbit 계좌 조회로 키·허용 IP를 검증한 뒤에야 바뀐다. 드라이런으로 지금 보류/최근
 * 결정이 실계좌에서 어떤 주문이 될지 미리 본다.
 */
function TradingModeCard({ isOwner, hasUpbitKeys }: { isOwner: boolean; hasUpbitKeys: boolean }) {
  const { data: st, mutate, error } = useSWR("crypto-mode", getTradingMode, { refreshInterval: 30_000 })
  const [arming, setArming] = useState(false)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof getLivePreview>> | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  const switchTo = async (mode: "paper" | "real") => {
    setBusy(true)
    try {
      const r = await setTradingMode(mode)
      mutate(r, { revalidate: false })
      setArming(false); setTyped("")
      toast[mode === "real" ? "warning" : "success"](mode === "real" ? `실주문 모드 ON — 실계좌 ${krw(r.live.equityKrw)}` : "페이퍼 모드로 전환")
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "전환 실패")
      mutate()
    } finally {
      setBusy(false)
    }
  }
  const runPreview = async () => {
    setPreviewBusy(true)
    try { setPreview(await getLivePreview()) } catch (err) { toast.error(err instanceof ApiError ? err.message : "드라이런 실패") } finally { setPreviewBusy(false) }
  }

  const real = st?.mode === "real"
  return (
    <Card className={cn(real && "border-destructive/60")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">거래 모드</h2>
        {st ? (
          <span className={cn("rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold", real ? "bg-destructive/15 text-destructive" : "bg-chart-1/15 text-chart-1")}>
            {real ? "REAL — Upbit 실계좌" : "PAPER — 가상 장부"}
          </span>
        ) : error ? (
          <span className="font-mono text-[10px] text-destructive">상태 조회 실패</span>
        ) : (
          <Skeleton className="h-4 w-24" />
        )}
        {st?.since && <span className="text-[10px] text-muted-foreground">{new Date(st.since).toLocaleString("ko-KR", { hour12: false })} · {st.by}</span>}
        {st?.killSwitch && <span className="rounded-sm bg-destructive px-1.5 py-0.5 font-mono text-[10px] text-destructive-foreground">킬스위치 ON</span>}
      </div>
      <div className="flex flex-col gap-3 p-4 text-xs">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          제어 평면의 결정이 어디로 나가는지 정한다. PAPER는 가상 장부, REAL은 Upbit 실계좌에 시장가 주문이 나간다.
          REAL로 켜는 순간 계좌 조회로 키·허용 IP·권한을 검증하고, 실패하면 모드는 바뀌지 않는다. 주문당 상한 {krw(st?.limits.maxOrderKrw)}, 킬스위치가 켜지면 전면 차단.
        </p>
        {real && st?.live && (
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] sm:grid-cols-4">
            <div><div className="text-[10px] text-muted-foreground">실계좌 에쿼티</div>{krw(st.live.equityKrw)}</div>
            <div><div className="text-[10px] text-muted-foreground">현금 (묶임)</div>{krw(st.live.cashKrw)} <span className="text-muted-foreground">({krw(st.live.lockedKrw)})</span></div>
            <div><div className="text-[10px] text-muted-foreground">보유 종목</div>{st.live.positions ?? "—"}</div>
            <div><div className="text-[10px] text-muted-foreground">동기화</div>{st.live.syncedAt ? new Date(st.live.syncedAt).toLocaleTimeString("ko-KR", { hour12: false }) : "—"}</div>
            {st.live.error && <div className="col-span-full text-destructive">동기화 오류: {st.live.error}</div>}
          </div>
        )}
        {!isOwner ? (
          <p className="text-[11px] text-muted-foreground">owner 계정만 전환할 수 있습니다.</p>
        ) : real ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => switchTo("paper")} className={cn("rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted", busy && "opacity-60")}>
              {busy ? "…" : "PAPER로 돌아가기"}
            </button>
            <button type="button" disabled={previewBusy} onClick={runPreview} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">
              {previewBusy ? "…" : "드라이런 — 다음 집행 미리보기"}
            </button>
          </div>
        ) : !arming ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={!hasUpbitKeys || !!st?.killSwitch} onClick={() => setArming(true)} className={cn("flex items-center gap-1 rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground", (!hasUpbitKeys || st?.killSwitch) && "opacity-50")}>
              <AlertTriangle className="size-3" aria-hidden="true" /> 실주문 모드로 전환
            </button>
            {!hasUpbitKeys && <span className="text-[11px] text-muted-foreground">먼저 위에서 Upbit 키를 저장하세요.</span>}
            <button type="button" disabled={previewBusy || !hasUpbitKeys} onClick={runPreview} className={cn("rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted", !hasUpbitKeys && "opacity-50")}>
              {previewBusy ? "…" : "드라이런 — 실계좌 기준 주문 미리보기"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <p className="text-[11px] text-destructive">
              지금부터 제어 평면의 모든 집행이 <b>실제 돈</b>으로 나갑니다. 확인하려면 <span className="font-mono">REAL</span> 을 입력하세요.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="REAL" autoComplete="off" className="w-28 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm" />
              <button type="button" disabled={typed !== "REAL" || busy} onClick={() => switchTo("real")} className={cn("rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground", (typed !== "REAL" || busy) && "opacity-50")}>
                {busy ? "계좌 검증 중…" : "실주문 켜기"}
              </button>
              <button type="button" onClick={() => { setArming(false); setTyped("") }} className="text-[11px] text-muted-foreground hover:underline">취소</button>
            </div>
          </div>
        )}
        {preview && (
          <div className="rounded-md border border-border p-3 font-mono text-[11px]">
            <div className="mb-1 text-[10px] text-muted-foreground">
              드라이런 {preview.decision ? `· 결정 ${preview.decision.id} (${preview.decision.status})` : ""} {preview.account && `· 실계좌 현금 ${krw(preview.account.cashKrw)} · 에쿼티 ${krw(preview.equityKrw)}`}
            </div>
            {preview.gate && <div className="text-destructive">관문 차단: {preview.gate}</div>}
            {preview.note && <div className="text-muted-foreground">{preview.note}</div>}
            {preview.orders.length === 0 && !preview.note && <div className="text-muted-foreground">보낼 주문 없음</div>}
            {preview.orders.map((o, i) => (
              <div key={i} className="flex gap-2">
                <span className={o.side === "buy" ? "text-chart-2" : "text-chart-1"}>{o.side === "buy" ? "매수" : "매도"}</span>
                <span>{o.market}</span>
                <span>{o.side === "buy" ? krw(o.amountKrw) : `${o.volume} (≈${krw(o.amountKrw)})`}</span>
                <span className="text-muted-foreground">{o.note}</span>
              </div>
            ))}
            {preview.skipped.length > 0 && <div className="mt-1 text-muted-foreground">스킵: {preview.skipped.join(" · ")}</div>}
          </div>
        )}
      </div>
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
      <TradingModeCard isOwner={me.user.role === "owner"} hasUpbitKeys={Boolean(src.upbit)} />
      <div className="grid gap-4 lg:grid-cols-2">
        <KeyForm provider="upbit" title="Upbit Open API" hint="업비트 마이페이지 → Open API 관리에서 발급. 권한은 자산조회·주문만 켜고 출금은 끄세요. 허용 IP에는 Railway Static IP 3개를 등록해야 합니다 (docs/deploy-railway.md). 저장한 뒤 위 '거래 모드'에서 REAL로 켭니다. 시세·백테스트·페이퍼는 키 없이도 돕니다." masked={keys?.keys.upbit ?? null} onSaved={onSaved} />
        <KeyForm provider="kis" title="한국투자증권 KIS Open API" hint="KIS Developers에서 실전/모의 키를 따로 발급. 서버의 KIS_MODE(mock/real)와 맞는 키를 넣으세요. MOCK_DATA=false로 바꿔야 실계좌 보유가 붙습니다." masked={keys?.keys.kis ?? null} onSaved={onSaved} />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        환경변수에 키가 있으면 그것이 우선이고(표시: env), 없으면 owner 계정의 금고(vault)를 씁니다. 지금 거래 엔진은 서버당 하나라 owner의 키만 쓰입니다 — 사용자별 데스크 분리는 docs/accounts.md의 다음 단계입니다.
      </p>
    </div>
  )
}
