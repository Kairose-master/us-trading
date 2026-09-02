"use client"

import { useState } from "react"
import useSWR from "swr"
import { Bot, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Card, Skeleton } from "@/components/primitives"
import { ApiError, getAutoTrade, setAutoTrade } from "@/lib/api"
import type { AutoTradeRecord } from "@/lib/types"

const OUTCOME_CLASS: Record<AutoTradeRecord["outcome"], string> = {
  accepted: "bg-chart-1/15 text-chart-1",
  blocked: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
}

const OUTCOME_KO: Record<AutoTradeRecord["outcome"], string> = {
  accepted: "접수",
  blocked: "차단",
  error: "오류",
}

/**
 * 자동매매 실행기 카드 — 파이프라인 신호 → 리스크 관문 → 주문.
 * 토글은 백엔드 /api/autotrade와 동일한 규칙(킬스위치 시 켤 수 없음)을 따른다.
 */
export function AutoTradeCard() {
  const { data: status, mutate, isLoading } = useSWR("autotrade", getAutoTrade, { refreshInterval: 4000 })
  const [busy, setBusy] = useState(false)

  const toggle = async () => {
    if (!status || busy) return
    setBusy(true)
    try {
      const next = await setAutoTrade(!status.enabled)
      await mutate(next, { revalidate: false })
      toast.success(next.enabled ? "자동매매를 켰습니다 — 모든 주문은 리스크 관문을 지납니다" : "자동매매를 껐습니다")
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "자동매매 상태를 변경하지 못했습니다 (공개 대시보드는 읽기 전용)")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">자동매매 실행기</h2>
          {status?.killSwitchActive && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
              <ShieldAlert className="size-3" aria-hidden="true" /> 킬스위치 활성화
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <span className="font-mono text-[11px] text-muted-foreground">
              오늘 체결 {status.executedToday}건 · {status.mock ? "모의" : "실전"}
            </span>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={status?.enabled ?? false}
            aria-label="자동매매 켜기/끄기"
            disabled={!status || busy}
            onClick={toggle}
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors disabled:opacity-50",
              status?.enabled ? "bg-chart-1" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-5 rounded-full bg-background shadow transition-all",
                status?.enabled ? "left-[22px]" : "left-0.5",
              )}
            />
          </button>
        </div>
      </div>

      <div className="px-4 py-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          파이프라인 실행 신호를 시장가 주문으로 바꿉니다. 신호도 주문도 <span className="font-medium text-foreground/80">리스크 관문(riskManager)</span>을
          예외 없이 지나며, 심볼당 5분 쿨다운 · 1회 금액은 한도의 절반 · 공매도 없음이 적용됩니다.
        </p>
      </div>

      {isLoading && !status ? (
        <div className="flex flex-col gap-2 p-4 pt-1">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : status && status.recent.length > 0 ? (
        <ul className="max-h-44 divide-y divide-border/50 overflow-y-auto border-t border-border font-mono text-[11px]">
          {status.recent.map((r, i) => (
            <li key={`${r.ts}-${i}`} className="flex items-center gap-2.5 px-4 py-1.5">
              <time dateTime={r.ts} className="shrink-0 text-muted-foreground/70">
                {new Date(r.ts).toLocaleTimeString("ko-KR", { hour12: false })}
              </time>
              <span className="w-12 shrink-0 font-bold">{r.symbol}</span>
              <span className={cn("shrink-0 font-semibold", r.side === "buy" ? "text-chart-1" : "text-destructive")}>
                {r.side === "buy" ? "매수" : "매도"} {r.qty}주
              </span>
              <span className={cn("shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold leading-none", OUTCOME_CLASS[r.outcome])}>
                {OUTCOME_KO[r.outcome]}
              </span>
              <span className="min-w-0 truncate text-muted-foreground">{r.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t border-border px-4 py-3 text-center text-[11px] text-muted-foreground/60">
          아직 실행 이력이 없습니다 — 켜면 신호 발생 시 여기에 기록됩니다.
        </p>
      )}
    </Card>
  )
}
