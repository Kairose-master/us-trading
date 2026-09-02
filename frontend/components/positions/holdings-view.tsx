"use client"

import useSWR from "swr"
import { Bitcoin, Landmark } from "lucide-react"
import { ApiError, getHoldings, isBackendNotConfigured } from "@/lib/api"
import { fmtPct, pnlClass } from "@/lib/format"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { PositionsTable } from "@/components/positions/positions-table"
import { cn } from "@/lib/utils"

const krw = (v: number) => `₩${Math.round(v).toLocaleString("ko-KR")}`
const signedKrw = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}₩${Math.abs(Math.round(v)).toLocaleString("ko-KR")}`

export function useHoldings() {
  return useSWR("holdings", getHoldings, { refreshInterval: 8000 })
}

/**
 * 보유종목 = 크립토 페이퍼 장부(Upbit 실시세) + 미국 장부(KIS 실계좌 또는 페이퍼).
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

  const c = data.crypto
  const u = data.us

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <Bitcoin className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">크립토 — Upbit {c.mode === "real" ? "실계좌" : "페이퍼 장부"}</h2>
          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {c.mode === "real" ? "REAL" : `PAPER · 시드 ${krw(c.startKrw)}${c.since ? ` · ${c.since.slice(0, 10)}~` : ""}`}
          </span>
          <span className="ml-auto font-mono text-xs tnum">
            평가 {krw(c.equityKrw)} · <span className={pnlClass(c.pnlKrw)}>{signedKrw(c.pnlKrw)} ({fmtPct(c.pnlPct)})</span> · 현금 {krw(c.cashKrw)}
          </span>
        </div>
        {c.positions.length === 0 ? (
          <div className="p-4">
            <EmptyState title="크립토 보유 없음" hint="스캐너 로테이션이나 오피스 결정이 실행되면 여기에 쌓입니다." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-[11px] text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="px-4 py-2 text-left font-medium">마켓</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  <th className="px-3 py-2 text-right font-medium">평단(₩)</th>
                  <th className="px-3 py-2 text-right font-medium">현재가(₩)</th>
                  <th className="px-3 py-2 text-right font-medium">평가금액</th>
                  <th className="px-3 py-2 text-right font-medium">손익</th>
                  <th className="px-3 py-2 text-right font-medium">비중</th>
                </tr>
              </thead>
              <tbody className="font-mono tnum">
                {c.positions.map((p) => (
                  <tr key={p.symbol} className="border-b border-border/40 last:border-0">
                    <td className="px-4 py-2 font-semibold">KRW-{p.symbol}</td>
                    <td className="px-3 py-2 text-right">{p.qty.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                    <td className="px-3 py-2 text-right">{p.avgKrw.toLocaleString("ko-KR")}</td>
                    <td className="px-3 py-2 text-right">{p.curKrw > 0 ? p.curKrw.toLocaleString("ko-KR") : "—"}</td>
                    <td className="px-3 py-2 text-right">{krw(p.valueKrw)}</td>
                    <td className={cn("px-3 py-2 text-right", pnlClass(p.pnlKrw))}>
                      {signedKrw(p.pnlKrw)} ({fmtPct(p.pnlPct)})
                    </td>
                    <td className="px-3 py-2 text-right">{p.weightPct.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
    </div>
  )
}
