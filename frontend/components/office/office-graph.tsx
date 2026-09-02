"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { OfficeRoster, OfficeRun } from "@/lib/api"

/**
 * 오피스 그래프 — 옵시디언 스타일 포스 다이어그램 (캔버스, 의존성 없음).
 *
 * 노드: 역할(에이전트) · 각 역할의 전용 툴 · 워커 서버 · Handsel escrow · 페이퍼 장부 ·
 *       (선택된 run이 있으면) 결정이 가리키는 마켓
 * 엣지: 핸드오프(dependsOn, 상류→하류) · 동료검토(reviewOf, 점선) · 툴 배선 · 결정(위원장→마켓, 비중)
 * 상태: run.stepStatuses(폴링마다 갱신)를 링 색으로 — Completed 초록, Submitted/Claimed 노랑 펄스, ❌/Expired 빨강
 *
 * 입력: 드래그(노드 이동·배경 팬), 휠(커서 기준 줌), 호버(이웃 강조), 클릭(onSelect)
 */

type NodeKind = "role" | "tool" | "worker" | "handsel" | "ledger" | "market"
interface GNode {
  id: string
  label: string
  sub?: string
  kind: NodeKind
  color: string
  r: number
  x: number
  y: number
  vx: number
  vy: number
  fixed?: boolean
  layer: number
}
interface GEdge {
  a: string
  b: string
  kind: "handoff" | "review" | "tool" | "decision" | "infra"
  label?: string
}

const STATUS_COLOR: Record<string, string> = {
  Completed: "#34d399",
  Submitted: "#fbbf24",
  Claimed: "#fbbf24",
  Open: "#94a3b8",
  Posted: "#94a3b8",
  "…": "#475569",
  Expired: "#f87171",
  "❌": "#f87171",
}

function buildGraph(roster: OfficeRoster, run: OfficeRun | null): { nodes: GNode[]; edges: GEdge[] } {
  const nodes: GNode[] = []
  const edges: GEdge[] = []
  // 레이어: 의존 깊이 (분석가 0 → 퀀트 1 → 리스크 2 → 리밸런스 3 → 레드팀 4 → 위원장 5)
  const depth = new Map<string, number>()
  const roleById = new Map(roster.roles.map((r) => [r.id, r]))
  const d = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!
    const r = roleById.get(id)
    if (!r) return 0
    const ups = [...r.dependsOn, ...(r.reviewOf ? [r.reviewOf] : [])]
    const v = ups.length ? Math.max(...ups.map(d)) + 1 : 0
    depth.set(id, v)
    return v
  }
  roster.roles.forEach((r) => d(r.id))
  const maxDepth = Math.max(1, ...depth.values())

  for (const r of roster.roles) {
    nodes.push({ id: r.id, label: r.nameKo, sub: r.name, kind: "role", color: r.color, r: r.id === "chair" ? 17 : r.id === "quant-modeler" ? 15 : 12, x: 0, y: 0, vx: 0, vy: 0, layer: depth.get(r.id) ?? 0 })
    if (r.tool) {
      nodes.push({ id: `tool:${r.id}`, label: r.tool, kind: "tool", color: r.color, r: 5, x: 0, y: 0, vx: 0, vy: 0, layer: depth.get(r.id) ?? 0 })
      edges.push({ a: `tool:${r.id}`, b: r.id, kind: "tool" })
      edges.push({ a: "worker", b: `tool:${r.id}`, kind: "infra" })
    }
  }
  for (const e of roster.edges) edges.push({ a: e.from, b: e.to, kind: e.kind })
  nodes.push({ id: "worker", label: "MCP 워커", sub: roster.workerUrl.replace(/^https?:\/\//, "").replace(/\/api\/mcp$/, ""), kind: "worker", color: "#64748b", r: 9, x: 0, y: 0, vx: 0, vy: 0, layer: 0 })
  nodes.push({ id: "handsel", label: "Handsel escrow", sub: "채점 통과분만 지급", kind: "handsel", color: "#c084fc", r: 11, x: 0, y: 0, vx: 0, vy: 0, layer: Math.round(maxDepth / 2) })
  nodes.push({ id: "ledger", label: "페이퍼 장부", sub: "Upbit paper", kind: "ledger", color: "#38bdf8", r: 11, x: 0, y: 0, vx: 0, vy: 0, layer: maxDepth + 1 })
  edges.push({ a: "chair", b: "ledger", kind: "decision", label: "결정 JSON" })
  for (const r of roster.roles) edges.push({ a: "handsel", b: r.id, kind: "infra" })

  const targets = run?.decision?.targets ?? []
  for (const t of targets) {
    if (t.weightPct <= 0) continue
    nodes.push({ id: `mkt:${t.market}`, label: t.market, sub: `${t.weightPct}%`, kind: "market", color: "#38bdf8", r: 5 + Math.min(8, t.weightPct / 6), x: 0, y: 0, vx: 0, vy: 0, layer: maxDepth + 2 })
    edges.push({ a: "ledger", b: `mkt:${t.market}`, kind: "decision", label: `${t.weightPct}%` })
  }
  return { nodes, edges }
}

export function OfficeGraph({ roster, run, onSelect, selected, height = 520 }: { roster: OfficeRoster; run: OfficeRun | null; onSelect?: (roleId: string | null) => void; selected?: string | null; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const graph = useMemo(() => buildGraph(roster, run), [roster, run])
  const stepStatuses = run?.stepStatuses ?? {}
  const stateRef = useRef({ nodes: [] as GNode[], edges: [] as GEdge[], alpha: 1, cam: { x: 0, y: 0, k: 1 }, hover: null as string | null, drag: null as { id: string | null; sx: number; sy: number; ox: number; oy: number } | null, w: 0, h: 0 })
  const [hoverId, setHoverId] = useState<string | null>(null)
  const statusRef = useRef(stepStatuses)
  statusRef.current = stepStatuses
  const selRef = useRef(selected)
  selRef.current = selected

  // 그래프가 바뀌면 위치를 이어받되(같은 id) 새 노드는 레이어 기준으로 심는다
  useEffect(() => {
    const st = stateRef.current
    const prev = new Map(st.nodes.map((n) => [n.id, n]))
    const maxLayer = Math.max(1, ...graph.nodes.map((n) => n.layer))
    const byLayer = new Map<number, GNode[]>()
    for (const n of graph.nodes) byLayer.set(n.layer, [...(byLayer.get(n.layer) ?? []), n])
    for (const n of graph.nodes) {
      const p = prev.get(n.id)
      if (p) {
        n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; n.fixed = p.fixed
      } else {
        const row = byLayer.get(n.layer)!
        const i = row.indexOf(n)
        n.x = ((n.layer + 0.5) / (maxLayer + 1) - 0.5) * 720 + (Math.random() - 0.5) * 40
        n.y = ((i + 0.5) / row.length - 0.5) * 380 + (Math.random() - 0.5) * 40
      }
    }
    st.nodes = graph.nodes
    st.edges = graph.edges
    st.alpha = 1
  }, [graph])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const st = stateRef.current
    const ctx = canvas.getContext("2d")!
    let raf = 0

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      st.w = rect.width; st.h = rect.height
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const idx = () => new Map(st.nodes.map((n) => [n.id, n]))

    const tick = () => {
      const nodes = st.nodes, edges = st.edges
      const byId = idx()
      const maxLayer = Math.max(1, ...nodes.map((n) => n.layer))
      if (st.alpha > 0.005) {
        // 반발
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i]
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j]
            let dx = b.x - a.x, dy = b.y - a.y
            let d2 = dx * dx + dy * dy
            if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
            const dist = Math.sqrt(d2)
            const f = (2200 * (a.kind === "tool" || b.kind === "tool" ? 0.45 : 1)) / d2
            const fx = (dx / dist) * f, fy = (dy / dist) * f
            if (!a.fixed) { a.vx -= fx; a.vy -= fy }
            if (!b.fixed) { b.vx += fx; b.vy += fy }
          }
        }
        // 스프링
        for (const e of edges) {
          const a = byId.get(e.a), b = byId.get(e.b)
          if (!a || !b) continue
          const rest = e.kind === "tool" ? 38 : e.kind === "infra" ? 150 : e.kind === "decision" ? 90 : 120
          const kS = e.kind === "infra" ? 0.004 : e.kind === "tool" ? 0.05 : 0.02
          const dx = b.x - a.x, dy = b.y - a.y
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))
          const f = (dist - rest) * kS
          const fx = (dx / dist) * f, fy = (dy / dist) * f
          if (!a.fixed) { a.vx += fx; a.vy += fy }
          if (!b.fixed) { b.vx -= fx; b.vy -= fy }
        }
        // 레이어 x 편향(파이프라인이 왼→오로 읽히게) + 중심 중력
        for (const n of nodes) {
          if (n.fixed) continue
          const tx = ((n.layer + 0.5) / (maxLayer + 1) - 0.5) * 760
          n.vx += (tx - n.x) * 0.012
          n.vy += -n.y * 0.008
          n.vx *= 0.82; n.vy *= 0.82
          n.x += n.vx * st.alpha; n.y += n.vy * st.alpha
        }
        st.alpha *= 0.985
      }

      // ===== 그리기 =====
      const { w, h, cam } = st
      ctx.clearRect(0, 0, w, h)
      const bg = ctx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, Math.max(w, h) * 0.75)
      bg.addColorStop(0, "#111827"); bg.addColorStop(1, "#05070d")
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h)
      ctx.save()
      ctx.translate(w / 2 + cam.x, h / 2 + cam.y); ctx.scale(cam.k, cam.k)
      const now = performance.now()
      const hover = st.hover
      const sel = selRef.current ?? null
      const focus = hover ?? sel
      const neighbors = new Set<string>()
      if (focus) { neighbors.add(focus); for (const e of edges) { if (e.a === focus) neighbors.add(e.b); if (e.b === focus) neighbors.add(e.a) } }
      const dim = (id: string) => (focus ? (neighbors.has(id) ? 1 : 0.18) : 1)

      for (const e of edges) {
        const a = byId.get(e.a), b = byId.get(e.b)
        if (!a || !b) continue
        const alpha = Math.min(dim(a.id), dim(b.id)) * (e.kind === "infra" ? 0.12 : e.kind === "tool" ? 0.35 : 0.55)
        ctx.globalAlpha = alpha
        ctx.lineWidth = e.kind === "review" ? 1.4 : e.kind === "decision" ? 1.6 : 1
        ctx.strokeStyle = e.kind === "review" ? "#fb923c" : e.kind === "decision" ? "#38bdf8" : e.kind === "infra" ? "#94a3b8" : "#cbd5e1"
        ctx.setLineDash(e.kind === "review" ? [5, 4] : e.kind === "infra" ? [2, 6] : [])
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
        ctx.setLineDash([])
        // 방향 화살표(핸드오프·검토·결정)
        if (e.kind === "handoff" || e.kind === "review" || e.kind === "decision") {
          const dx = b.x - a.x, dy = b.y - a.y
          const dist = Math.max(1, Math.hypot(dx, dy))
          const ux = dx / dist, uy = dy / dist
          const px = b.x - ux * (b.r + 4), py = b.y - uy * (b.r + 4)
          ctx.fillStyle = ctx.strokeStyle
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - ux * 7 - uy * 3.5, py - uy * 7 + ux * 3.5); ctx.lineTo(px - ux * 7 + uy * 3.5, py - uy * 7 - ux * 3.5); ctx.closePath(); ctx.fill()
        }
        if (e.label && alpha > 0.3) {
          ctx.globalAlpha = alpha
          ctx.fillStyle = "#7dd3fc"; ctx.font = "9px ui-monospace, monospace"; ctx.textAlign = "center"
          ctx.fillText(e.label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 4)
        }
      }
      for (const n of nodes) {
        const al = dim(n.id)
        ctx.globalAlpha = al
        const status = n.kind === "role" ? statusRef.current[n.id] : undefined
        const sc = status ? STATUS_COLOR[status] ?? "#94a3b8" : null
        // 글로우
        const g = ctx.createRadialGradient(n.x, n.y, n.r * 0.3, n.x, n.y, n.r * 2.6)
        g.addColorStop(0, n.color + (n.kind === "tool" ? "66" : "99")); g.addColorStop(1, n.color + "00")
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 2.6, 0, Math.PI * 2); ctx.fill()
        // 본체
        ctx.fillStyle = n.kind === "tool" ? "#0f172a" : n.color
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill()
        if (n.kind === "tool") { ctx.lineWidth = 1.2; ctx.strokeStyle = n.color; ctx.stroke() }
        // 상태 링
        if (sc) {
          const pulse = status === "Submitted" || status === "Claimed" ? 1 + 0.25 * Math.sin(now / 250) : 1
          ctx.lineWidth = 2.2; ctx.strokeStyle = sc
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4 * pulse, 0, Math.PI * 2); ctx.stroke()
        }
        if (sel === n.id || hover === n.id) {
          ctx.lineWidth = 1.5; ctx.strokeStyle = "#f8fafc"; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 8, 0, Math.PI * 2); ctx.stroke()
        }
        // 라벨
        const showLabel = n.kind !== "tool" || cam.k > 0.9 || focus === n.id || neighbors.has(n.id)
        if (showLabel) {
          ctx.fillStyle = n.kind === "tool" ? "#94a3b8" : "#e2e8f0"
          ctx.font = `${n.kind === "role" ? "600 " : ""}${n.kind === "tool" ? 9 : 11}px ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = "center"
          ctx.fillText(n.label, n.x, n.y + n.r + 13)
          if (n.sub && (n.kind !== "tool") && (cam.k > 0.8 || focus === n.id)) {
            ctx.fillStyle = "#64748b"; ctx.font = "9px ui-monospace, monospace"
            ctx.fillText(n.sub, n.x, n.y + n.r + 24)
          }
        }
      }
      ctx.restore()
      ctx.globalAlpha = 1
      // 상태 펄스 때문에 계속 그린다 (alpha 냉각으로 물리는 멈춘다)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const toWorld = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect()
      const sx = cx - rect.left, sy = cy - rect.top
      return { x: (sx - st.w / 2 - st.cam.x) / st.cam.k, y: (sy - st.h / 2 - st.cam.y) / st.cam.k, sx, sy }
    }
    const hit = (wx: number, wy: number) => {
      let best: GNode | null = null, bd = Infinity
      for (const n of st.nodes) {
        const d = Math.hypot(n.x - wx, n.y - wy)
        if (d < n.r + 8 && d < bd) { best = n; bd = d }
      }
      return best
    }
    const onMove = (ev: PointerEvent) => {
      const { x, y, sx, sy } = toWorld(ev.clientX, ev.clientY)
      if (st.drag) {
        if (st.drag.id) {
          const n = st.nodes.find((k) => k.id === st.drag!.id)
          if (n) { n.x = x; n.y = y; n.vx = 0; n.vy = 0; n.fixed = true; st.alpha = Math.max(st.alpha, 0.3) }
        } else {
          st.cam.x = st.drag.ox + (sx - st.drag.sx); st.cam.y = st.drag.oy + (sy - st.drag.sy)
        }
        return
      }
      const n = hit(x, y)
      const id = n?.id ?? null
      if (id !== st.hover) { st.hover = id; setHoverId(id); canvas.style.cursor = id ? "pointer" : "grab" }
    }
    const onDown = (ev: PointerEvent) => {
      const { x, y, sx, sy } = toWorld(ev.clientX, ev.clientY)
      const n = hit(x, y)
      st.drag = { id: n?.id ?? null, sx, sy, ox: st.cam.x, oy: st.cam.y }
      canvas.setPointerCapture(ev.pointerId)
      canvas.style.cursor = n ? "grabbing" : "grabbing"
    }
    const onUp = (ev: PointerEvent) => {
      const { x, y, sx, sy } = toWorld(ev.clientX, ev.clientY)
      const moved = st.drag ? Math.hypot(sx - st.drag.sx, sy - st.drag.sy) > 4 : false
      if (st.drag?.id) { const n = st.nodes.find((k) => k.id === st.drag!.id); if (n && !moved) n.fixed = false }
      if (!moved) {
        const n = hit(x, y)
        onSelect?.(n && n.kind === "role" ? n.id : null)
      }
      st.drag = null
      canvas.style.cursor = "grab"
    }
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const { sx, sy } = toWorld(ev.clientX, ev.clientY)
      const k0 = st.cam.k
      const k1 = Math.min(3, Math.max(0.35, k0 * Math.exp(-ev.deltaY * 0.0015)))
      // 커서 기준 줌
      const wx = (sx - st.w / 2 - st.cam.x) / k0, wy = (sy - st.h / 2 - st.cam.y) / k0
      st.cam.k = k1
      st.cam.x = sx - st.w / 2 - wx * k1; st.cam.y = sy - st.h / 2 - wy * k1
    }
    canvas.addEventListener("pointermove", onMove)
    canvas.addEventListener("pointerdown", onDown)
    canvas.addEventListener("pointerup", onUp)
    canvas.addEventListener("wheel", onWheel, { passive: false })
    canvas.style.cursor = "grab"
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener("pointermove", onMove)
      canvas.removeEventListener("pointerdown", onDown)
      canvas.removeEventListener("pointerup", onUp)
      canvas.removeEventListener("wheel", onWheel)
    }
  }, [onSelect])

  const hovered = hoverId ? graph.nodes.find((n) => n.id === hoverId) : null
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-[#05070d]" style={{ height }}>
      <canvas ref={canvasRef} className="block h-full w-full touch-none" aria-label="증권 오피스 에이전트 그래프" role="img" />
      <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-black/40 px-2.5 py-1.5 font-mono text-[10px] text-slate-300 backdrop-blur">
        <span><i className="mr-1 inline-block h-2 w-4 border-t border-slate-300 align-middle" />핸드오프</span>
        <span><i className="mr-1 inline-block h-2 w-4 border-t border-dashed border-orange-400 align-middle" />동료검토(REVISE 루프)</span>
        <span><i className="mr-1 inline-block h-2 w-4 border-t border-sky-400 align-middle" />결정 → 장부</span>
        <span><i className="mr-1 inline-block size-2 rounded-full border-2 border-emerald-400 align-middle" />채점 통과</span>
        <span><i className="mr-1 inline-block size-2 rounded-full border-2 border-amber-400 align-middle" />작업/채점 중</span>
        <span><i className="mr-1 inline-block size-2 rounded-full border-2 border-red-400 align-middle" />실패</span>
      </div>
      {hovered && (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-xs rounded-md bg-black/60 px-3 py-2 text-[11px] text-slate-200 backdrop-blur">
          <p className="font-semibold" style={{ color: hovered.color }}>{hovered.label}{hovered.sub ? <span className="ml-1 font-mono text-[10px] text-slate-400">{hovered.sub}</span> : null}</p>
          {hovered.kind === "role" && (
            <p className="text-slate-400">
              {roster.roles.find((r) => r.id === hovered.id)?.tool ? `툴: ${roster.roles.find((r) => r.id === hovered.id)?.tool}` : "플랫폼 에이전트 — 상류 산출물만 읽고 쓴다"}
              {stepStatuses[hovered.id] ? ` · 상태 ${stepStatuses[hovered.id]}` : ""}
            </p>
          )}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 right-3 font-mono text-[10px] text-slate-500">드래그 이동 · 휠 줌 · 클릭 선택</div>
    </div>
  )
}
