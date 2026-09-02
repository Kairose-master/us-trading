"use client"

import useSWR from "swr"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { getPipelineNode, type Market } from "@/lib/api"
import type { PipelineNodeStatus } from "@/lib/types"

const STATUS_LABEL: Record<PipelineNodeStatus, string> = {
  active: "동작 중",
  idle: "유휴",
  error: "오류",
}

const STATUS_CLASS: Record<PipelineNodeStatus, string> = {
  active: "bg-chart-1/15 text-chart-1",
  idle: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
}

export function NodeInspector({ nodeId, market = "us", onClose }: { nodeId: string; market?: Market; onClose: () => void }) {
  const { data: node, isLoading } = useSWR(["pipeline-node", market, nodeId], () => getPipelineNode(nodeId, market), {
    refreshInterval: 2000,
  })

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{node?.name ?? "노드 상세"}</h2>
          {node && (
            <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold leading-none", STATUS_CLASS[node.metrics.status])}>
              {STATUS_LABEL[node.metrics.status]}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="인스펙터 닫기"
        >
          <X className="size-4" />
        </button>
      </div>

      {isLoading && !node ? (
        <div className="flex flex-col gap-3 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={`insp-skel-${i}`} className="h-5 w-full" />
          ))}
        </div>
      ) : !node ? (
        <EmptyState title="노드 정보를 불러올 수 없습니다" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="grid grid-cols-3 gap-2">
            <MetricTile label="레이턴시" value={`${node.metrics.avgLatencyMs.toFixed(2)}ms`} />
            <MetricTile label="처리량" value={`${node.metrics.throughputPerSec.toFixed(1)}/s`} />
            <MetricTile label="누적" value={node.metrics.totalMsgs.toLocaleString()} />
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">{node.description}</p>

          <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] text-chart-2">
            {node.codeHint}
          </pre>

          {node.metrics.lastError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {node.metrics.lastError}
            </p>
          )}

          <div className="flex min-h-0 flex-col gap-1.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              라이브 샘플 <span className="text-muted-foreground/60">(최근 {node.sample.rows.length}건)</span>
            </p>
            {node.sample.rows.length === 0 ? (
              <EmptyState title="아직 샘플이 없습니다" hint="데이터가 흐르면 여기에 나타납니다." />
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                      {node.sample.columns.map((c) => (
                        <th key={c} className="px-2 py-1.5 font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {node.sample.rows.slice(0, 12).map((row, i) => (
                      <tr key={`row-${i}-${row[0]}`}>
                        {row.map((cell, j) => (
                          <td key={`cell-${i}-${j}`} className="whitespace-nowrap px-2 py-1 text-foreground/85">
                            {typeof cell === "number" ? cell.toLocaleString() : cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background px-2.5 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="font-mono text-sm font-semibold">{value}</p>
    </div>
  )
}
