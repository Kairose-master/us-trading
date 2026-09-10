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

const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedUsd = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`

/** 미국주식 계좌만 — /account/holdings 실기록의 us 부분 + Yahoo 환율. 크립토는 /crypto 데스크 */
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
  const u = data.us
  const fx = data.fx.rate
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label={u.connected ? `미국주식 평가 (KIS ${u.mode === "real" ? "실계좌" : "모의계좌"})` : "미국주식 평가 (KIS 미연결 · 페이퍼)"}
        value={usd(u.equityUsd)}
        sub={fx > 0 ? `≈ ${krw(u.equityUsd * fx)} · 환율 ₩${fx.toLocaleString("ko-KR")}` : "환율 미수신"}
      />
      <StatCard label="평가손익" value={signedUsd(u.pnlUsd)} sub={`${fmtPct(u.pnlPct)}${fx > 0 ? ` · ${signedKrw(u.pnlUsd * fx)}` : ""}`} valueClass={pnlClass(u.pnlUsd)} />
      <StatCard label="현금 (USD)" value={usd(u.cashUsd)} sub={u.connected ? undefined : `페이퍼 시드 $${u.startUsd.toLocaleString()}`} />
      <StatCard label="보유 종목" value={String(u.positions.length)} sub={u.connected ? `KIS ${u.mode}` : "KIS 키를 설정에 넣으면 실계좌"} />
    </div>
  )
}
