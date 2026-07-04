"use client"

import { useState } from "react"
import { Play, Square, Settings2, ScrollText, CircleAlert } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Card } from "@/components/primitives"
import { fmtUsd } from "@/lib/format"
import { pnlClass } from "@/lib/format"
import { startStrategy, stopStrategy, ApiError } from "@/lib/api"
import type { Strategy, StrategyStatus } from "@/lib/types"

const STATUS_META: Record<StrategyStatus, { label: string; dot: string; text: string }> = {
  running: { label: "실행 중", dot: "bg-up", text: "text-up" },
  stopped: { label: "정지됨", dot: "bg-muted-foreground", text: "text-muted-foreground" },
  error: { label: "오류", dot: "bg-destructive", text: "text-destructive" },
}

export function StrategyCard({
  strategy,
  onChanged,
  onEditConfig,
  onViewLogs,
}: {
  strategy: Strategy
  onChanged: () => void
  onEditConfig: (s: Strategy) => void
  onViewLogs: (s: Strategy) => void
}) {
  const [busy, setBusy] = useState(false)
  const meta = STATUS_META[strategy.status]
  const running = strategy.status === "running"

  async function toggle() {
    setBusy(true)
    try {
      if (running) {
        await stopStrategy(strategy.id)
        toast.success(`${strategy.name} 전략을 정지했습니다.`)
      } else {
        await startStrategy(strategy.id)
        toast.success(`${strategy.name} 전략을 시작했습니다.`)
      }
      onChanged()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "요청에 실패했습니다.")
    } finally {
      setBusy(false)
    }
  }

  const cfg = strategy.config

  return (
    <Card className={cn("flex flex-col gap-4 p-4", strategy.status === "error" && "border-destructive/50")}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="truncate text-sm font-semibold">{strategy.name}</h3>
          <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", meta.text)}>
            <span className={cn("size-1.5 rounded-full", meta.dot, running && "animate-pulse")} aria-hidden="true" />
            {meta.label}
          </span>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            running
              ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
              : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {running ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
          {busy ? "처리 중..." : running ? "정지" : "시작"}
        </button>
      </div>

      {strategy.status === "error" && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" />
          <span>전략 실행 중 오류가 발생했습니다. 로그를 확인하세요.</span>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-3 rounded-md bg-muted/40 p-3">
        <div className="flex flex-col gap-0.5">
          <dt className="text-[11px] text-muted-foreground">오늘 손익</dt>
          <dd className={cn("font-mono text-sm font-semibold", pnlClass(strategy.todayPnlUsd))}>
            {fmtUsd(strategy.todayPnlUsd, { sign: true })}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[11px] text-muted-foreground">보유 포지션</dt>
          <dd className="font-mono text-sm font-semibold">
            {strategy.positionCount}
            <span className="text-xs font-normal text-muted-foreground"> / {cfg.maxPositions}</span>
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1.5 text-xs">
        <p className="line-clamp-2 text-muted-foreground" title={cfg.entryRule}>
          <span className="font-medium text-foreground">진입: </span>
          {cfg.entryRule}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span>손절 -{cfg.stopLossPct}%</span>
          <span>익절 +{cfg.takeProfitPct}%</span>
          <span>종목당 {fmtUsd(cfg.maxAmountPerSymbolUsd, { decimals: 0 })}</span>
          <span>{cfg.allowedSession === "extended" ? "주간+시간외" : "정규장만"}</span>
        </div>
      </div>

      <div className="mt-auto flex gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => onEditConfig(strategy)}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-border text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Settings2 className="size-3.5" />
          설정
        </button>
        <button
          type="button"
          onClick={() => onViewLogs(strategy)}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-border text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ScrollText className="size-3.5" />
          로그
        </button>
      </div>
    </Card>
  )
}
