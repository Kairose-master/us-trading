"use client"

import { OctagonX } from "lucide-react"
import { StatCards } from "@/components/dashboard/stat-cards"
import { EquityChart } from "@/components/dashboard/equity-chart"
import { TickerStrip } from "@/components/dashboard/ticker-strip"
import { MarketCountdown } from "@/components/dashboard/market-countdown"
import { CommandCenter } from "@/components/dashboard/command-center"
import { useSystemStatus } from "@/components/shell/kill-switch"

function KillSwitchNotice() {
  const { data } = useSystemStatus()
  if (!data?.killSwitchActive) return null
  return (
    <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4" role="alert">
      <OctagonX className="size-5 shrink-0 text-destructive" aria-hidden="true" />
      <div>
        <p className="text-sm font-bold text-destructive">킬 스위치 활성화 — 자동매매 전체 정지 상태</p>
        <p className="text-xs text-muted-foreground">리스크 페이지에서 상태를 확인하고 수동으로 재개하세요.</p>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">대시보드</h1>
        <MarketCountdown />
      </div>
      <KillSwitchNotice />
      <StatCards />
      <CommandCenter />
      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <EquityChart />
        </div>
        <div className="xl:col-span-2">
          <TickerStrip />
        </div>
      </div>
    </div>
  )
}
