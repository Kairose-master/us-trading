"use client"

import { cn } from "@/lib/utils"
import type { PipelineNode, PipelineSnapshot, PipelineStage } from "@/lib/types"

/**
 * 파이프라인 DAG 시각화 — 스테이지별 컬럼에 노드를 배치하고
 * SVG 곡선으로 데이터 흐름을 그린다. 노드 색은 실측 상태를 따른다.
 */

const STAGE_LABEL: Record<PipelineStage, string> = {
  ingestion: "INGESTION",
  features: "FEATURES",
  models: "MODELS",
  strategy: "STRATEGY",
  execution: "EXECUTION",
}

const W = 1080
const H = 460
const NODE_W = 168
const NODE_H = 58
const TOP = 44

interface Pos {
  x: number
  y: number
}

function layout(snapshot: PipelineSnapshot): Map<string, Pos> {
  const pos = new Map<string, Pos>()
  const stages = snapshot.stages
  const colW = W / stages.length
  for (let si = 0; si < stages.length; si++) {
    const nodes = snapshot.nodes.filter((n) => n.stage === stages[si])
    const usable = H - TOP
    const gap = usable / (nodes.length + 1)
    nodes.forEach((n, i) => {
      pos.set(n.id, {
        x: colW * si + (colW - NODE_W) / 2,
        y: TOP + gap * (i + 1) - NODE_H / 2,
      })
    })
  }
  return pos
}

function statusColor(n: PipelineNode): string {
  if (n.metrics.status === "error") return "var(--destructive)"
  if (n.metrics.status === "active") return "var(--chart-2)"
  return "var(--muted-foreground)"
}

export function PipelineDag({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: PipelineSnapshot
  selected: string | null
  onSelect: (id: string) => void
}) {
  const pos = layout(snapshot)
  const colW = W / snapshot.stages.length

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="min-w-[860px]"
        role="img"
        aria-label="데이터 파이프라인 노드 그래프"
      >
        {/* 스테이지 헤더 + 구분선 */}
        {snapshot.stages.map((s, i) => (
          <g key={s}>
            <text
              x={colW * i + colW / 2}
              y={22}
              textAnchor="middle"
              className="fill-muted-foreground font-mono text-[11px] font-semibold tracking-widest"
            >
              {STAGE_LABEL[s]}
            </text>
            {i > 0 && (
              <line x1={colW * i} y1={34} x2={colW * i} y2={H - 8} className="stroke-border" strokeDasharray="2 6" />
            )}
          </g>
        ))}

        {/* 엣지 */}
        {snapshot.edges.map((e) => {
          const from = pos.get(e.from)
          const to = pos.get(e.to)
          if (!from || !to) return null
          const x1 = from.x + NODE_W
          const y1 = from.y + NODE_H / 2
          const x2 = to.x
          const y2 = to.y + NODE_H / 2
          const mx = (x1 + x2) / 2
          const active =
            snapshot.nodes.find((n) => n.id === e.from)?.metrics.status === "active" &&
            snapshot.nodes.find((n) => n.id === e.to)?.metrics.status === "active"
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
              fill="none"
              strokeWidth={1.5}
              className={cn(active ? "stroke-chart-2/60" : "stroke-border")}
              strokeDasharray={active ? "6 4" : undefined}
            >
              {active && (
                <animate attributeName="stroke-dashoffset" from="20" to="0" dur="1.2s" repeatCount="indefinite" />
              )}
            </path>
          )
        })}

        {/* 노드 */}
        {snapshot.nodes.map((n) => {
          const p = pos.get(n.id)
          if (!p) return null
          const isSel = selected === n.id
          const color = statusColor(n)
          return (
            <g
              key={n.id}
              transform={`translate(${p.x}, ${p.y})`}
              onClick={() => onSelect(n.id)}
              className="cursor-pointer"
              role="button"
              aria-label={`${n.name} 노드 상세`}
              aria-pressed={isSel}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                className={cn("fill-card transition-all", isSel ? "stroke-primary" : "stroke-border hover:stroke-muted-foreground")}
                strokeWidth={isSel ? 2 : 1}
              />
              <circle cx={14} cy={16} r={4} fill={color}>
                {n.metrics.status === "active" && (
                  <animate attributeName="opacity" values="1;0.35;1" dur="2s" repeatCount="indefinite" />
                )}
              </circle>
              <text x={26} y={20} className="fill-foreground text-[12px] font-semibold">
                {n.name}
              </text>
              <text x={14} y={42} className="fill-muted-foreground font-mono text-[10px]">
                {n.metrics.avgLatencyMs.toFixed(2)}ms · {n.metrics.throughputPerSec.toFixed(1)}/s
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
