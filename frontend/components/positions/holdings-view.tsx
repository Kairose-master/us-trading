"use client"

import useSWR from "swr"
import Link from "next/link"
import { Bitcoin, Landmark } from "lucide-react"
import { ApiError, getHoldings, isBackendNotConfigured } from "@/lib/api"
import { fmtPct, pnlClass } from "@/lib/format"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { PositionsTable } from "@/components/positions/positions-table"


export function useHoldings() {
  return useSWR("holdings", getHoldings, { refreshInterval: 8000 })
}

/**
 * 보유종목(미국주식) = KIS 실계좌 또는 페이퍼 장부. 크립토 보유는 /crypto 데스크에 따로 있다.
 * 심어 놓은 가짜 포지션은 없다 — 비어 있으면 비어 있다고 보여준다.
 */
export function HoldingsView() {
  const { data, error, isLoading } = useHoldings()

  if (isBackendNotConfigured(error)) {
    return (
      <Card className="p-4">
        <EmptyState title="백엔드 미연결" hint="Vercel 환경변수 BACKEND_TOKEN이 있어야 실보유가 보입니다." />
      </Card>
    )
  }
  if (error instanceof ApiError) return <Card className="p-4 text-xs text-destructive">불러오기 실패: {error.message}</Card>
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />

  const u = data.us

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <Landmark className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">미국주식 — {u.connected ? `KIS ${u.mode === "real" ? "실계좌" : "모의계좌"}` : "KIS 미연결"}</h2>
          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {u.connected ? u.mode.toUpperCase() : `PAPER · 시드 $${u.startUsd.toLocaleString()}`}
          </span>
          <span className="ml-auto font-mono text-xs tnum">
            평가 ${u.equityUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })} ·{" "}
            <span className={pnlClass(u.pnlUsd)}>
              {u.pnlUsd >= 0 ? "+" : "-"}${Math.abs(u.pnlUsd).toFixed(2)} ({fmtPct(u.pnlPct)})
            </span>
            {data.fx.rate > 0 ? ` · 환율 ₩${data.fx.rate.toLocaleString("ko-KR")}` : " · 환율 미수신"}
          </span>
        </div>
        {!u.connected && (
          <p className="px-4 py-2 text-[11px] text-muted-foreground">
            KIS Open API 키를 설정에 등록하면 실계좌 보유가 여기에 뜹니다. 지금은 페이퍼 장부이고, 보유가 없으면 비어 있는 게 맞습니다.
          </p>
        )}
      </Card>
      <PositionsTable />
      <Link href="/crypto" className="inline-flex w-fit items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
        <Bitcoin className="size-3" aria-hidden="true" /> 크립토 보유는 크립토 데스크에서 봅니다
      </Link>
    </div>
  )
}
