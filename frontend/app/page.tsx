"use client"

import Link from "next/link"
import { Bitcoin, OctagonX } from "lucide-react"
import { StatCards } from "@/components/dashboard/stat-cards"
import { TickerStrip } from "@/components/dashboard/ticker-strip"
import { MarketCountdown } from "@/components/dashboard/market-countdown"
import { PositionsTable } from "@/components/positions/positions-table"
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

/** 미국주식 대시보드 — KIS 계좌·시세·보유만. 크립토는 /crypto 데스크로 분리 */
export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold">미국주식 대시보드 — KIS</h1>
          <Link href="/crypto" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
            <Bitcoin className="size-3" aria-hidden="true" /> 크립토는 데스크에서
          </Link>
        </div>
        <MarketCountdown />
      </div>
      <KillSwitchNotice />
      <StatCards />
      <TickerStrip />
      <PositionsTable />
    </div>
  )
}
