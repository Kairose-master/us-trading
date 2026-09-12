"use client"

import useSWR from "swr"
import { ShieldAlert } from "lucide-react"
import { getExitStatus, type ExitStatus } from "@/lib/api"
import { fmtPct, pnlClass } from "@/lib/format"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { cn } from "@/lib/utils"

const px = (v: number | null) => (v == null || v <= 0 ? "—" : v >= 100 ? Math.round(v).toLocaleString("ko-KR") : v.toPrecision(4))
const KIND_KO: Record<ExitStatus["log"][number]["kind"], string> = { stop: "손절", trail: "트레일링", take: "익절", stale: "지지 소멸" }
const hhmm = (iso: string) => new Date(iso).toLocaleString("ko-KR", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })

export function useExitStatus() {
  return useSWR("crypto-exits", getExitStatus, { refreshInterval: 15_000, shouldRetryOnError: false })
}

/**
 * 청산 규칙 현황 — 보유 종목별 손절선·트레일링선·익절선, 재진입 금지, 최근 청산.
 * 규칙 수정은 설정 페이지. 협의회 회전과 별개로 데스크가 10초마다 검사해 즉시 판다.
 */
export function CryptoExitsCard() {
  const { data: ex, error, isLoading } = useExitStatus()
  if (isLoading && !ex) return <Skeleton className="h-24" />
  if (error || !ex) return null
  const r = ex.rules
  const summary = `손절 −${r.stopLossPct}% · 트레일링 −${r.trailingStopPct}% · 익절 +${r.takeProfitPct}%에 ${r.takeProfitSellPct}% · 지지 소멸 ${r.staleHours}h · 재진입 금지 ${r.reentryCooldownMin}분`
  const blocked = ex.mode === "real" && (ex.killSwitch || !ex.tradeEnabled)
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <ShieldAlert className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">청산 규칙</h2>
        <span className={cn("rounded-sm px-1.5 py-0.5 font-mono text-[10px]", r.enabled ? "bg-chart-1/15 text-chart-1" : "bg-destructive/15 text-destructive")}>{r.enabled ? "ON" : "OFF"}</span>
        <span className="text-[11px] text-muted-foreground">{summary}</span>
        {blocked && <span className="rounded-sm bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive">{ex.killSwitch ? "킬스위치 — 청산도 차단" : "자동매매 OFF — 청산 기록만"}</span>}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">검사 {ex.lastCheckAt ? new Date(ex.lastCheckAt).toLocaleTimeString("ko-KR", { hour12: false }) : "대기"}</span>
      </div>
      {ex.positions.length === 0 ? (
        <div className="p-4"><EmptyState title="감시 중인 보유 없음" hint="보유가 생기면 종목별 손절선·트레일링선·익절선이 여기에 뜹니다." /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-[11px] text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="px-4 py-2 text-left font-medium">마켓</th>
                <th className="px-3 py-2 text-right font-medium">현재가</th>
                <th className="px-3 py-2 text-right font-medium">평단 대비</th>
                <th className="px-3 py-2 text-right font-medium">손절선</th>
                <th className="px-3 py-2 text-right font-medium">고점</th>
                <th className="px-3 py-2 text-right font-medium">트레일링선</th>
                <th className="px-3 py-2 text-right font-medium">익절선</th>
                <th className="px-3 py-2 text-left font-medium">지지</th>
              </tr>
            </thead>
            <tbody className="font-mono tnum">
              {ex.positions.map((p) => {
                const nearest = p.curKrw > 0 ? Math.max(p.stopKrw, p.trailKrw) : 0
                const gapPct = p.curKrw > 0 && nearest > 0 ? ((nearest - p.curKrw) / p.curKrw) * 100 : null
                return (
                  <tr key={p.symbol} className="border-b border-border/40 last:border-0">
                    <td className="px-4 py-2 font-semibold">KRW-{p.symbol}</td>
                    <td className="px-3 py-2 text-right">{px(p.curKrw)}</td>
                    <td className={cn("px-3 py-2 text-right", pnlClass(p.pnlPct))}>{fmtPct(p.pnlPct)}</td>
                    <td className={cn("px-3 py-2 text-right", p.trailKrw < p.stopKrw && "text-destructive")}>{px(p.stopKrw)}</td>
                    <td className="px-3 py-2 text-right">{px(p.highKrw)}</td>
                    <td className={cn("px-3 py-2 text-right", p.trailKrw >= p.stopKrw && "text-destructive")}>{px(p.trailKrw)}{gapPct != null && <span className="ml-1 text-[10px] text-muted-foreground">({gapPct.toFixed(1)}%)</span>}</td>
                    <td className="px-3 py-2 text-right">{p.tpTaken ? <span className="text-[10px] text-muted-foreground">익절 완료</span> : px(p.takeKrw)}</td>
                    <td className="px-3 py-2 text-left text-[11px]">{p.unsupportedSince ? <span className="text-destructive">소멸 {hhmm(p.unsupportedSince)}~</span> : <span className="text-muted-foreground">유지</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {(ex.cooldown.length > 0 || ex.log.length > 0) && (
        <div className="flex flex-col gap-1.5 border-t border-border px-4 py-2.5 text-[11px]">
          {ex.cooldown.length > 0 && (
            <div className="text-muted-foreground">재진입 금지: {ex.cooldown.map((c) => `${c.symbol} (~${hhmm(c.until)})`).join(" · ")}</div>
          )}
          {ex.log.slice(0, 5).map((e, i) => (
            <div key={`${e.ts}-${i}`} className={cn("font-mono", e.error ? "text-destructive" : "text-foreground")}>
              {hhmm(e.ts)} [{e.mode === "real" ? "REAL" : "paper"}] {KIND_KO[e.kind]} {e.market.replace("KRW-", "")} {e.sellPct}% <span className={pnlClass(e.pnlPct)}>({fmtPct(e.pnlPct)})</span> — {e.error ?? e.reason}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
