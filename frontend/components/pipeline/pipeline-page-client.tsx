"use client"

import { useState } from "react"
import useSWR from "swr"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { ApiError, getPipeline, getPipelineLogs, isBackendNotConfigured, type Market } from "@/lib/api"
import { useLiveChannel } from "@/hooks/useLiveSocket"
import type { PipelineLogLine, PipelineSnapshot } from "@/lib/types"
import { PipelineMonitor } from "./pipeline-monitor"
import { AutoTradeCard } from "./auto-trade-card"

export function PipelinePageClient() {
  const [market, setMarket] = useState<Market>("crypto")
  const [selected, setSelected] = useState<string | null>(null)
  const [live, setLive] = useState<PipelineSnapshot | null>(null)
  const [liveLogs, setLiveLogs] = useState<PipelineLogLine[]>([])

  const { data: fetched, isLoading, error } = useSWR(["pipeline", market], () => getPipeline(market), { refreshInterval: 5000 })
  const { data: fetchedLogs } = useSWR(["pipeline-logs", market], () => getPipelineLogs(80, market), { refreshInterval: 5000 })

  const chSnap = market === "crypto" ? "crypto:pipeline" : "pipeline"
  const chLog = market === "crypto" ? "crypto:pipeline:log" : "pipeline:log"
  useLiveChannel([chSnap, chLog], (raw) => {
    const msg = raw as unknown as { ch: string; data: unknown }
    if (msg.ch === chSnap) setLive(msg.data as PipelineSnapshot)
    if (msg.ch === chLog) setLiveLogs((prev) => [msg.data as PipelineLogLine, ...prev].slice(0, 80))
  })

  const switchMarket = (m: Market) => {
    setMarket(m)
    setLive(null)
    setLiveLogs([])
    setSelected(null)
  }

  const snapshot = live ?? fetched
  const notConfigured = isBackendNotConfigured(error)
  const errorMsg = error instanceof ApiError ? error.message : error ? String(error) : null
  // 라이브 로그 + 초기 로드 병합 (ts+message 기준 중복 제거)
  const logs = dedupeLogs([...liveLogs, ...(fetchedLogs ?? [])]).slice(0, 80)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">데이터 파이프라인 모니터</h1>
        <p className="text-[11px] text-muted-foreground">정형(시세 틱) + 비정형(뉴스)이 한 DAG로 흐른다 · 빛 하나 = 실제 마이크로배치 하나</p>
      </div>
      {market === "us" && <AutoTradeCard />}
      {isLoading && !snapshot ? (
        <Skeleton className="h-[640px] w-full" />
      ) : !snapshot ? (
        <Card className="p-4">
          <EmptyState
            title={notConfigured ? "백엔드 미연결" : "파이프라인 상태를 불러올 수 없습니다"}
            hint={notConfigured ? "이 배포에 BACKEND_TOKEN이 설정되지 않았습니다 — 목데이터로 대체하지 않습니다." : errorMsg ?? undefined}
          />
        </Card>
      ) : (
        <PipelineMonitor snapshot={snapshot} logs={logs} market={market} onMarket={switchMarket} selected={selected} onSelect={setSelected} />
      )}
    </div>
  )
}

function dedupeLogs(lines: PipelineLogLine[]): PipelineLogLine[] {
  const seen = new Set<string>()
  const out: PipelineLogLine[] = []
  for (const l of lines) {
    const key = `${l.ts}|${l.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}
