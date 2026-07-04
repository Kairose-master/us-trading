"use client"

import { useState } from "react"
import useSWR from "swr"
import { cn } from "@/lib/utils"
import { Modal, Skeleton, EmptyState } from "@/components/primitives"
import { getStrategyLogs } from "@/lib/api"
import type { LogLevel, Strategy } from "@/lib/types"

const LEVEL_CLASS: Record<LogLevel, string> = {
  INFO: "text-chart-2",
  WARN: "text-warning",
  ERROR: "text-destructive",
}

const FILTERS: (LogLevel | "ALL")[] = ["ALL", "INFO", "WARN", "ERROR"]

export function LogViewer({ strategy, onClose }: { strategy: Strategy | null; onClose: () => void }) {
  const [filter, setFilter] = useState<LogLevel | "ALL">("ALL")
  const { data: logs, isLoading } = useSWR(
    strategy ? ["strategy-logs", strategy.id] : null,
    () => getStrategyLogs(strategy!.id, 100),
    { refreshInterval: 5000 },
  )

  if (!strategy) return null

  const filtered = (logs ?? []).filter((l) => filter === "ALL" || l.level === filter)

  return (
    <Modal open onClose={onClose} title={`실행 로그 — ${strategy.name}`} className="max-w-2xl">
      <div className="flex flex-col gap-3">
        <div className="flex gap-1.5" role="tablist" aria-label="로그 레벨 필터">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "h-7 rounded-md px-2.5 font-mono text-[11px] font-medium transition-colors",
                filter === f
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {f === "ALL" ? "전체" : f}
            </button>
          ))}
        </div>

        <div className="h-80 overflow-y-auto rounded-md border border-border bg-background font-mono text-xs">
          {isLoading && !logs ? (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={`log-skel-${i}`} className="h-4 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState title="표시할 로그가 없습니다" hint="필터를 변경하거나 잠시 후 다시 확인하세요." />
          ) : (
            <ul className="divide-y divide-border/50">
              {filtered.map((log, i) => (
                <li key={`${log.ts}-${i}`} className="flex items-start gap-3 px-3 py-1.5 leading-relaxed">
                  <time dateTime={log.ts} className="shrink-0 text-muted-foreground/70">
                    {new Date(log.ts).toLocaleTimeString("ko-KR", { hour12: false })}
                  </time>
                  <span className={cn("w-11 shrink-0 font-semibold", LEVEL_CLASS[log.level])}>{log.level}</span>
                  <span className="min-w-0 break-words text-foreground/90">
                    {log.message}
                    {log.context && (
                      <span className="ml-2 text-muted-foreground/60">{JSON.stringify(log.context)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-right text-[11px] text-muted-foreground/60">5초마다 자동 갱신 · 최근 100건</p>
      </div>
    </Modal>
  )
}
