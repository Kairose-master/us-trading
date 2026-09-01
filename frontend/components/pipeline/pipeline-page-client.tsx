"use client"

import { useState } from "react"
import useSWR from "swr"
import { Activity, Gauge, Network, Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { getPipeline, getPipelineLogs } from "@/lib/api"
import { useLiveChannel } from "@/hooks/useLiveSocket"
import type { PipelineLogLine, PipelineSnapshot } from "@/lib/types"
import { PipelineDag } from "./pipeline-dag"
import { NodeInspector } from "./node-inspector"

export function PipelinePageClient() {
  const [selected, setSelected] = useState<string | null>(null)
  const [live, setLive] = useState<PipelineSnapshot | null>(null)
  const [liveLogs, setLiveLogs] = useState<PipelineLogLine[]>([])

  const { data: fetched, isLoading } = useSWR("pipeline", getPipeline, { refreshInterval: 5000 })
  const { data: fetchedLogs } = useSWR("pipeline-logs", () => getPipelineLogs(80), { refreshInterval: 5000 })

  useLiveChannel(["pipeline", "pipeline:log"], (msg) => {
    if (msg.ch === "pipeline") setLive(msg.data)
    if (msg.ch === "pipeline:log") setLiveLogs((prev) => [msg.data, ...prev].slice(0, 80))
  })

  const snapshot = live ?? fetched
  // 라이브 로그 + 초기 로드 병합 (ts+message 기준 중복 제거)
  const logs = dedupeLogs([...liveLogs, ...(fetchedLogs ?? [])]).slice(0, 80)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">데이터 파이프라인</h1>
        {snapshot && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] font-semibold",
              snapshot.status === "active" ? "bg-chart-1/15 text-chart-1" : "bg-muted text-muted-foreground",
            )}
          >
            <Radio className="size-3" aria-hidden="true" />
            {snapshot.status === "active" ? "PIPELINE ACTIVE" : "STOPPED"}
          </span>
        )}
      </div>

      {/* 핵심 지표 — 전부 실측값 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={<Gauge className="size-4" aria-hidden="true" />}
          label="파이프라인 레이턴시"
          value={snapshot ? `${snapshot.latencyMs.toFixed(2)} ms` : null}
          hint="전체 노드 평균 합산"
        />
        <StatCard
          icon={<Network className="size-4" aria-hidden="true" />}
          label="활성 노드"
          value={snapshot ? `${snapshot.nodesActive}/${snapshot.nodesTotal}` : null}
          hint="최근 20초 내 처리 기록"
        />
        <StatCard
          icon={<Activity className="size-4" aria-hidden="true" />}
          label="알파 안정성"
          value={snapshot ? snapshot.alphaStability.toFixed(3) : null}
          hint="1 − 알파 변화율 EMA"
        />
        <StatCard
          icon={<Radio className="size-4" aria-hidden="true" />}
          label="정형 + 비정형"
          value={snapshot ? `${snapshot.stages.length} 스테이지` : null}
          hint="시세 틱 · 뉴스 스트림 통합"
        />
      </div>

      <div className={cn("grid gap-4", selected ? "xl:grid-cols-[1fr_360px]" : "")}>
        <Card className="p-3">
          {isLoading && !snapshot ? (
            <Skeleton className="h-[420px] w-full" />
          ) : !snapshot ? (
            <EmptyState title="파이프라인 상태를 불러올 수 없습니다" />
          ) : (
            <PipelineDag snapshot={snapshot} selected={selected} onSelect={(id) => setSelected((cur) => (cur === id ? null : id))} />
          )}
          <p className="px-2 pt-1 text-right text-[11px] text-muted-foreground/60">노드를 클릭하면 실측 지표와 라이브 샘플이 열립니다</p>
        </Card>
        {selected && (
          <div className="min-h-[420px]">
            <NodeInspector nodeId={selected} onClose={() => setSelected(null)} />
          </div>
        )}
      </div>

      {/* 실행 로그 */}
      <Card>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">실행 로그</h2>
          <p className="text-[11px] text-muted-foreground/60">감성 신호 · 실행 신호 · 리스크 차단 사유</p>
        </div>
        <div className="max-h-64 overflow-y-auto font-mono text-xs">
          {logs.length === 0 ? (
            <EmptyState title="아직 로그가 없습니다" hint="파이프라인에 데이터가 흐르면 나타납니다." />
          ) : (
            <ul className="divide-y divide-border/50">
              {logs.map((log, i) => (
                <li key={`${log.ts}-${i}`} className="flex items-start gap-3 px-4 py-1.5 leading-relaxed">
                  <time dateTime={log.ts} className="shrink-0 text-muted-foreground/70">
                    {new Date(log.ts).toLocaleTimeString("ko-KR", { hour12: false })}
                  </time>
                  <span className="w-32 shrink-0 truncate text-chart-2">{log.node}</span>
                  <span className="min-w-0 break-words text-foreground/90">{log.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
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

function StatCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string | null; hint: string }) {
  return (
    <Card className="flex flex-col gap-1 p-3.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      {value === null ? <Skeleton className="h-6 w-20" /> : <p className="font-mono text-lg font-bold">{value}</p>}
      <p className="text-[10px] text-muted-foreground/60">{hint}</p>
    </Card>
  )
}
