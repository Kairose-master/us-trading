"use client"

import { fmtPct, pnlClass } from "@/lib/format"
import { Card, Skeleton } from "@/components/primitives"
import { useHoldings } from "@/components/positions/holdings-view"
import { cn } from "@/lib/utils"

const krw = (v: number) => `₩${Math.round(v).toLocaleString("ko-KR")}`
const signedKrw = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}₩${Math.abs(Math.round(v)).toLocaleString("ko-KR")}`

function StatCard({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xl font-semibold tnum", valueClass)}>{value}</span>
      {sub && <span className="font-mono text-xs tnum text-muted-foreground">{sub}</span>}
    </Card>
  )
}

/** 숫자는 전부 /account/holdings 실기록 — 크립토 페이퍼 장부 + 미국 장부 + Yahoo 환율 */
export function StatCards() {
  const { data, isLoading } = useHoldings()

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    )
  }
  const c = data.crypto
  const u = data.us
  const totalPnlKrw = data.fx.rate > 0 ? c.pnlKrw + u.pnlUsd * data.fx.rate : c.pnlKrw
  const totalStartKrw = data.fx.rate > 0 ? c.startKrw + u.startUsd * data.fx.rate : c.startKrw
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="총자산 (크립토 + 미국)"
        value={data.totalKrw !== null ? krw(data.totalKrw) : krw(c.equityKrw)}
        sub={data.fx.rate > 0 ? `환율 ₩${data.fx.rate.toLocaleString("ko-KR")} (Yahoo KRW=X)` : "환율 미수신 — 크립토만 합산"}
      />
      <StatCard
        label={`크립토 ${c.mode === "real" ? "실계좌" : "페이퍼"} (Upbit)`}
        value={krw(c.equityKrw)}
        sub={`${signedKrw(c.pnlKrw)} (${fmtPct(c.pnlPct)}) · 보유 ${c.positions.length}`}
        valueClass={pnlClass(c.pnlKrw)}
      />
      <StatCard
        label={u.connected ? `미국 KIS ${u.mode}` : "미국 (KIS 미연결 · 페이퍼)"}
        value={`$${u.equityUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
        sub={`${u.pnlUsd >= 0 ? "+" : "-"}$${Math.abs(u.pnlUsd).toFixed(2)} (${fmtPct(u.pnlPct)}) · 보유 ${u.positions.length}`}
        valueClass={pnlClass(u.pnlUsd)}
      />
      <StatCard
        label="총 평가손익"
        value={signedKrw(totalPnlKrw)}
        sub={totalStartKrw > 0 ? fmtPct((totalPnlKrw / totalStartKrw) * 100) : undefined}
        valueClass={pnlClass(totalPnlKrw)}
      />
    </div>
  )
}
