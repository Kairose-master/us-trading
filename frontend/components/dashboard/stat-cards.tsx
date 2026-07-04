"use client"

import useSWR from "swr"
import { getBalance } from "@/lib/api"
import { fmtKrwRaw, fmtPct, fmtUsd, pnlClass } from "@/lib/format"
import { Card, Skeleton } from "@/components/primitives"
import { cn } from "@/lib/utils"

export function useBalance() {
  return useSWR("balance", () => getBalance(), { refreshInterval: 5000 })
}

function StatCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string
  value: string
  sub?: string
  valueClass?: string
}) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xl font-semibold tnum", valueClass)}>{value}</span>
      {sub && <span className="font-mono text-xs tnum text-muted-foreground">{sub}</span>}
    </Card>
  )
}

export function StatCards() {
  const { data: bal, isLoading } = useBalance()

  if (isLoading || !bal) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="총평가금액"
        value={fmtUsd(bal.totalEquityUsd)}
        sub={`≈ ${fmtKrwRaw(bal.totalEquityUsd, bal.fxRate)}`}
      />
      <StatCard label="예수금 (USD)" value={fmtUsd(bal.cashUsd)} sub={`≈ ${fmtKrwRaw(bal.cashUsd, bal.fxRate)}`} />
      <StatCard
        label="당일 실현손익"
        value={`${fmtUsd(bal.todayPnlUsd, { sign: true })} (${fmtPct(bal.todayPnlPct)})`}
        valueClass={pnlClass(bal.todayPnlUsd)}
        sub={`≈ ${fmtKrwRaw(bal.todayPnlUsd, bal.fxRate)}`}
      />
      <StatCard
        label="총 평가손익"
        value={`${fmtUsd(bal.totalPnlUsd, { sign: true })} (${fmtPct(bal.totalPnlPct)})`}
        valueClass={pnlClass(bal.totalPnlUsd)}
        sub={`≈ ${fmtKrwRaw(bal.totalPnlUsd, bal.fxRate)}`}
      />
    </div>
  )
}
