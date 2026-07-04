"use client"

import { useState } from "react"
import useSWR from "swr"
import { Skeleton, EmptyState } from "@/components/primitives"
import { StrategyCard } from "@/components/strategies/strategy-card"
import { ConfigEditor } from "@/components/strategies/config-editor"
import { LogViewer } from "@/components/strategies/log-viewer"
import { getStrategies } from "@/lib/api"
import type { Strategy } from "@/lib/types"

export function StrategiesPageClient() {
  const { data: strategies, isLoading, mutate } = useSWR("strategies", () => getStrategies(), {
    refreshInterval: 10000,
  })
  const [editing, setEditing] = useState<Strategy | null>(null)
  const [viewingLogs, setViewingLogs] = useState<Strategy | null>(null)

  const runningCount = strategies?.filter((s) => s.status === "running").length ?? 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold">전략</h1>
          <p className="text-xs text-muted-foreground">
            {strategies ? `전체 ${strategies.length}개 · 실행 중 ${runningCount}개` : "불러오는 중..."}
          </p>
        </div>
      </div>

      {isLoading && !strategies ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`strat-skel-${i}`} className="h-64" />
          ))}
        </div>
      ) : !strategies || strategies.length === 0 ? (
        <EmptyState title="등록된 전략이 없습니다" hint="백엔드에 전략을 등록하면 여기에 표시됩니다." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {strategies.map((s) => (
            <StrategyCard
              key={s.id}
              strategy={s}
              onChanged={() => mutate()}
              onEditConfig={setEditing}
              onViewLogs={setViewingLogs}
            />
          ))}
        </div>
      )}

      <ConfigEditor strategy={editing} onClose={() => setEditing(null)} onSaved={() => mutate()} />
      <LogViewer strategy={viewingLogs} onClose={() => setViewingLogs(null)} />
    </div>
  )
}
