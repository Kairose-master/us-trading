"use client"

import { Card, ProgressBar } from "@/components/primitives"
import { fmtUsd } from "@/lib/format"
import type { RiskLimits } from "@/lib/types"

export function UsagePanel({ limits }: { limits: RiskLimits }) {
  const rows = [
    {
      label: "오늘 주문 금액",
      used: fmtUsd(limits.usage.orderAmountTodayUsd, { decimals: 0 }),
      cap: fmtUsd(limits.maxOrderAmountUsd, { decimals: 0 }),
      pct: (limits.usage.orderAmountTodayUsd / limits.maxOrderAmountUsd) * 100,
    },
    {
      label: "오늘 실현 손실",
      used: fmtUsd(limits.usage.dailyLossTodayUsd, { decimals: 0 }),
      cap: fmtUsd(limits.maxDailyLossUsd, { decimals: 0 }),
      pct: (limits.usage.dailyLossTodayUsd / limits.maxDailyLossUsd) * 100,
    },
    {
      label: "동시 보유 종목",
      used: `${limits.usage.openPositions}개`,
      cap: `${limits.maxOpenPositions}개`,
      pct: (limits.usage.openPositions / limits.maxOpenPositions) * 100,
    },
  ]

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h2 className="text-sm font-semibold">오늘 사용량</h2>
      <div className="flex flex-col gap-4">
        {rows.map((r) => {
          const danger = r.pct > 90
          return (
            <div key={r.label} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">{r.label}</span>
                <span className={danger ? "font-mono font-semibold text-destructive" : "font-mono text-foreground"}>
                  {r.used} <span className="text-muted-foreground/60">/ {r.cap}</span>
                </span>
              </div>
              <ProgressBar pct={r.pct} />
              {danger && <p className="text-[11px] font-medium text-destructive">한도에 근접했습니다.</p>}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
