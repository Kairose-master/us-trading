"use client"

import Link from "next/link"
import useSWR from "swr"
import { FlaskConical, Settings } from "lucide-react"
import { ApiError, getTradingMode, isBackendNotConfigured } from "@/lib/api"
import { fmtPct, pnlClass } from "@/lib/format"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { CommandCenter } from "@/components/dashboard/command-center"
import { EquityChart } from "@/components/dashboard/equity-chart"
import { useHoldings } from "@/components/positions/holdings-view"
import { CryptoHoldingsCard } from "@/components/crypto/crypto-holdings"
import { cn } from "@/lib/utils"

const krw = (v: number) => `₩${Math.round(v).toLocaleString("ko-KR")}`
const signedKrw = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}₩${Math.abs(Math.round(v)).toLocaleString("ko-KR")}`

function Stat({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xl font-semibold tnum", valueClass)}>{value}</span>
      {sub && <span className="font-mono text-xs tnum text-muted-foreground">{sub}</span>}
    </Card>
  )
}

/** 거래 모드 배지 — 설정 페이지의 스위치 상태. 실모드면 붉게 */
export function TradingModeBadge({ className }: { className?: string }) {
  const { data } = useSWR("crypto-mode", getTradingMode, { refreshInterval: 30_000, shouldRetryOnError: false })
  if (!data) return null
  const real = data.mode === "real"
  return (
    <Link
      href="/settings"
      title={real ? `실주문 모드 · ${data.since ? new Date(data.since).toLocaleString("ko-KR", { hour12: false }) : ""} · ${data.by ?? ""} — 설정에서 전환` : "페이퍼 모드 — 설정에서 전환"}
      className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] font-semibold", real ? "bg-destructive/15 text-destructive" : "bg-chart-1/15 text-chart-1", className)}
    >
      <span className={cn("size-1.5 rounded-full", real ? "bg-destructive animate-pulse" : "bg-chart-1")} aria-hidden="true" />
      {real ? "REAL — Upbit 실계좌" : "PAPER — 가상 장부"}
      {data.killSwitch && <span className="ml-1 rounded-sm bg-destructive px-1 text-[10px] text-destructive-foreground">KILL</span>}
    </Link>
  )
}

/**
 * 크립토 데스크 — Upbit 계좌(실/페이퍼)·제어 평면·보유·에쿼티. 미국주식과 섞지 않는다.
 * 실주문 전환은 여기서 못 하고 설정 페이지의 거래 모드 스위치에서만 한다.
 */
export function CryptoDesk() {
  const { data, error, isLoading } = useHoldings()
  const { data: mode } = useSWR("crypto-mode", getTradingMode, { refreshInterval: 30_000, shouldRetryOnError: false })

  const stats = () => {
    if (isBackendNotConfigured(error)) return <Card className="p-4"><EmptyState title="백엔드 미연결" hint="Vercel 환경변수 BACKEND_TOKEN이 있어야 계좌가 보입니다." /></Card>
    if (error instanceof ApiError) return <Card className="p-4 text-xs text-destructive">불러오기 실패: {error.message}</Card>
    if (isLoading || !data) return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
    const c = data.crypto
    const real = c.mode === "real"
    const live = mode?.live
    return (
      <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={real ? "실계좌 평가 (Upbit)" : "페이퍼 평가 (Upbit 실시세)"} value={krw(c.equityKrw)} sub={real ? `동기화 ${live?.syncedAt ? new Date(live.syncedAt).toLocaleTimeString("ko-KR", { hour12: false }) : "대기"}` : `시드 ${krw(c.startKrw)}`} />
          <Stat label={real ? "실모드 시작 이후 손익" : "페이퍼 손익"} value={signedKrw(c.pnlKrw)} sub={fmtPct(c.pnlPct)} valueClass={pnlClass(c.pnlKrw)} />
          <Stat label="현금 (KRW)" value={krw(c.cashKrw)} sub={real && live?.lockedKrw ? `미체결 묶임 ${krw(live.lockedKrw)}` : undefined} />
          <Stat label="보유 종목" value={String(c.positions.length)} sub={c.since ? `${c.since.slice(0, 10)}~` : undefined} />
        </div>
        {real && live?.error && <Card className="p-3 text-[11px] text-destructive">실계좌 동기화 오류: {live.error}</Card>}
        <CryptoHoldingsCard c={c} />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold">크립토 데스크 — Upbit</h1>
          <TradingModeBadge />
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Link href="/crypto/research" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground"><FlaskConical className="size-3" aria-hidden="true" /> 알파 리서치</Link>
          <Link href="/settings" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground"><Settings className="size-3" aria-hidden="true" /> 거래 모드 · 키</Link>
        </div>
      </div>
      {stats()}
      <CommandCenter />
      <EquityChart />
    </div>
  )
}
