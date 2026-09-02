"use client"

import { useEffect, useRef, useState } from "react"
import type { PipelineSnapshot, PipelineStage } from "@/lib/types"

/**
 * 파이프라인 모니터 그래프 — 스테이지 열(01 INGESTION → 05 EXECUTION)에 노드를 놓고
 * 곡선 엣지 위로 빛 하나 = 실제 마이크로배치 하나를 흘린다. 2.5D: 병렬 브랜치는
 * 깊이(z)로 분리돼 궤도 회전(드래그)하면 앞뒤가 갈리고, 초점 밖 깊이는 흐려진다.
 *
 * 그리는 것은 전부 실측이다. 빛은 스냅샷 간 totalMsgs 증가분에서만 생기고, 처리량이
 * 0이면 그래프는 멈춰 있다 — 그게 정직한 상태다.
 */

const STAGES: PipelineStage[] = ["ingestion", "features", "models", "strategy", "execution"]
export const STAGE_LABEL: Record<PipelineStage, string> = { ingestion: "INGESTION", features: "FEATURES", models: "MODELS", strategy: "STRATEGY", execution: "EXECUTION" }
export const STAGE_TAG: Record<PipelineStage, string> = { ingestion: "SRC", features: "FEAT", models: "ML", strategy: "PORT", execution: "EXEC" }
/** 브랜치 깊이 — 시세(정형) 브랜치는 앞, 뉴스(비정형) 브랜치는 뒤, 합류 노드는 중앙 */
const DEPTH: Record<string, number> = {
  "tick-data": 1, technical: 1.2, microstructure: 0.6, "alpha-technical": 0.9,
  "news-stream": -1, "sentiment-score": -1.1, "alpha-sentiment": -0.9,
  "alpha-ensemble": 0, portfolio: 0, "execution-router": 0,
}

interface N3 { id: string; stage: PipelineStage; col: number; row: number; rows: number; x: number; y: number; z: number; sx: number; sy: number; s: number; zz: number }
interface Pulse { edge: number; t: number; speed: number; hue: string }

export const STATUS_COLOR = { active: "#a3e635", idle: "#6b7280", error: "#ef4444" } as const
export const STATUS_LABEL = { active: "RUNNING", idle: "IDLE", error: "FAILED" } as const

export function fmtRate(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k/s`
  if (v >= 10) return `${v.toFixed(0)}/s`
  return `${v.toFixed(1)}/s`
}

export function MonitorGraph({ snapshot, selected, onSelect, mode, resetKey = 0, height = 520, sourceStatus = {} }: { snapshot: PipelineSnapshot; selected: string | null; onSelect: (id: string | null) => void; mode: "3d" | "flat"; resetKey?: number; height?: number; sourceStatus?: Record<string, string> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const st = useRef({
    nodes: [] as N3[],
    edges: [] as Array<{ a: string; b: string }>,
    pulses: [] as Pulse[],
    lastTotals: new Map<string, number>(),
    cam: { yaw: -0.22, pitch: 0.16, zoom: 1, panX: 0, panY: 0 },
    drag: null as null | { x: number; y: number; yaw: number; pitch: number; panX: number; panY: number; moved: boolean; pan: boolean },
    hover: null as string | null,
    w: 0, h: 0,
    snap: snapshot,
    mode,
    selected,
    sourceStatus,
  })
  const [hover, setHover] = useState<string | null>(null)
  st.current.snap = snapshot
  st.current.mode = mode
  st.current.selected = selected
  st.current.sourceStatus = sourceStatus

  // 레이아웃 + 실제 이벤트 → 빛
  useEffect(() => {
    const s = st.current
    const byStage = new Map<PipelineStage, typeof snapshot.nodes>()
    for (const n of snapshot.nodes) byStage.set(n.stage, [...(byStage.get(n.stage) ?? []), n])
    const prev = new Map(s.nodes.map((n) => [n.id, n]))
    s.nodes = snapshot.nodes.map((n) => {
      const col = STAGES.indexOf(n.stage)
      const row = byStage.get(n.stage)!
      const i = row.indexOf(n)
      const z = (DEPTH[n.id] ?? 0) * 80
      const p = prev.get(n.id)
      return { id: n.id, stage: n.stage, col, row: i, rows: row.length, x: 0, y: 0, z, sx: p?.sx ?? 0, sy: p?.sy ?? 0, s: p?.s ?? 1, zz: p?.zz ?? 0 }
    })
    s.edges = snapshot.edges.map((e) => ({ a: e.from, b: e.to }))
    // 스냅샷 간 totalMsgs 증가 = 그 노드로 들어오는 엣지마다 빛 하나 (실제 마이크로배치)
    for (const n of snapshot.nodes) {
      const last = s.lastTotals.get(n.id)
      const cur = n.metrics.totalMsgs
      if (last !== undefined && cur > last) {
        const incoming = s.edges.map((e, i) => (e.b === n.id ? i : -1)).filter((i) => i >= 0)
        const count = Math.min(3, cur - last)
        for (const ei of incoming) for (let k = 0; k < count; k++) s.pulses.push({ edge: ei, t: -k * 0.18, speed: 0.7 + Math.random() * 0.3, hue: n.metrics.status === "error" ? "#ef4444" : "#d9f99d" })
        if (s.pulses.length > 160) s.pulses.splice(0, s.pulses.length - 160)
      }
      s.lastTotals.set(n.id, cur)
    }
  }, [snapshot])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const s = st.current
    const ctx = canvas.getContext("2d")!
    let raf = 0
    let last = performance.now()

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const r = canvas.getBoundingClientRect()
      s.w = r.width; s.h = r.height
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const project = () => {
      const { yaw, pitch, zoom, panX, panY } = s.cam
      const flat = s.mode === "flat"
      const cy = Math.cos(flat ? 0 : yaw), sy = Math.sin(flat ? 0 : yaw)
      const cp = Math.cos(flat ? 0 : pitch), sp = Math.sin(flat ? 0 : pitch)
      const f = 900
      // 캔버스 크기에 맞춘 열/행 간격 — 라벨(오른쪽 ~150px)까지 화면 안에 들어오게
      const colGap = Math.max(120, (s.w - 330) / Math.max(1, STAGES.length - 1))
      const rowGap = Math.max(70, Math.min(120, (s.h - 140) / 3))
      for (const n of s.nodes) {
        n.x = (n.col - (STAGES.length - 1) / 2) * colGap - 55
        n.y = (n.row - (n.rows - 1) / 2) * rowGap
        const x1 = n.x * cy - n.z * sy
        const z1 = n.x * sy + n.z * cy
        const y1 = n.y * cp - z1 * sp
        const z2 = n.y * sp + z1 * cp
        const sc = (f / (f + z2)) * zoom
        n.sx = s.w / 2 + panX + x1 * sc
        n.sy = s.h / 2 + panY + y1 * sc
        n.s = sc
        n.zz = z2
      }
    }
    const bez = (a: N3, b: N3) => {
      const dx = Math.max(60, Math.abs(b.sx - a.sx) * 0.55)
      return { p0: [a.sx, a.sy], p1: [a.sx + dx, a.sy], p2: [b.sx - dx, b.sy], p3: [b.sx, b.sy] } as const
    }
    const bezAt = (c: ReturnType<typeof bez>, t: number) => {
      const u = 1 - t
      return [u * u * u * c.p0[0] + 3 * u * u * t * c.p1[0] + 3 * u * t * t * c.p2[0] + t * t * t * c.p3[0], u * u * u * c.p0[1] + 3 * u * u * t * c.p1[1] + 3 * u * t * t * c.p2[1] + t * t * t * c.p3[1]] as const
    }
    const blurFor = (zz: number) => (s.mode === "flat" ? 0 : Math.min(4, Math.abs(zz) / 55))

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      // (now는 상태 펄스에도 쓴다)
      // 아주 느린 궤도 드리프트 — 카메라만 움직인다 (데이터는 실측 그대로)
      if (!s.drag && s.mode === "3d") s.cam.yaw += dt * 0.03
      project()
      const byId = new Map(s.nodes.map((n) => [n.id, n]))
      const snap = s.snap
      const metrics = new Map(snap.nodes.map((n) => [n.id, n]))
      const { w, h } = s
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = "#070907"; ctx.fillRect(0, 0, w, h)
      // 은은한 비네트
      const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, Math.max(w, h) * 0.8)
      vg.addColorStop(0, "rgba(163,230,53,0.035)"); vg.addColorStop(1, "rgba(0,0,0,0)")
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h)

      // 스테이지 헤더
      const cols = STAGES.map((stg, i) => {
        const nodes = s.nodes.filter((n) => n.stage === stg)
        const x = nodes.length ? nodes.reduce((a, n) => a + n.sx, 0) / nodes.length : 0
        return { stg, x, count: nodes.length }
      })
      ctx.textAlign = "center"
      for (const [i, c] of cols.entries()) {
        if (!c.count) continue
        ctx.fillStyle = "#4b5a4b"; ctx.font = "500 9px ui-monospace, SFMono-Regular, monospace"
        ctx.fillText(`0${i + 1}`, c.x, 18)
        ctx.fillStyle = "#c7d2c7"; ctx.font = "700 11px ui-monospace, SFMono-Regular, monospace"
        ctx.fillText(STAGE_LABEL[c.stg], c.x, 32)
        ctx.fillStyle = "#4b5a4b"; ctx.font = "9px ui-monospace, SFMono-Regular, monospace"
        ctx.fillText(`${c.count} steps`, c.x, 44)
      }

      const focus = s.hover ?? s.selected
      const near = new Set<string>()
      if (focus) { near.add(focus); for (const e of s.edges) { if (e.a === focus) near.add(e.b); if (e.b === focus) near.add(e.a) } }
      const dim = (id: string) => (focus ? (near.has(id) ? 1 : 0.22) : 1)

      // 엣지 (뒤 → 앞)
      const edgesSorted = s.edges.map((e, i) => ({ e, i, a: byId.get(e.a)!, b: byId.get(e.b)! })).filter((x) => x.a && x.b).sort((p, q) => q.a.zz + q.b.zz - (p.a.zz + p.b.zz))
      for (const { e, a, b } of edgesSorted) {
        const c = bez(a, b)
        const active = (metrics.get(e.a)?.metrics.status === "active") && (metrics.get(e.b)?.metrics.status !== "error")
        ctx.filter = blurFor((a.zz + b.zz) / 2) > 0.5 ? `blur(${blurFor((a.zz + b.zz) / 2).toFixed(1)}px)` : "none"
        ctx.globalAlpha = Math.min(dim(e.a), dim(e.b)) * (active ? 0.55 : 0.25)
        ctx.strokeStyle = active ? "#65a30d" : "#374151"
        ctx.lineWidth = 1.2 * Math.min(a.s, b.s)
        ctx.beginPath(); ctx.moveTo(c.p0[0], c.p0[1]); ctx.bezierCurveTo(c.p1[0], c.p1[1], c.p2[0], c.p2[1], c.p3[0], c.p3[1]); ctx.stroke()
      }
      ctx.filter = "none"

      // 빛 (실제 마이크로배치)
      for (let i = s.pulses.length - 1; i >= 0; i--) {
        const p = s.pulses[i]
        p.t += dt * p.speed
        if (p.t > 1.05) { s.pulses.splice(i, 1); continue }
        if (p.t < 0) continue
        const e = s.edges[p.edge]
        const a = byId.get(e?.a ?? ""), b = byId.get(e?.b ?? "")
        if (!a || !b) { s.pulses.splice(i, 1); continue }
        const [x, y] = bezAt(bez(a, b), p.t)
        const sc = a.s + (b.s - a.s) * p.t
        ctx.globalAlpha = Math.min(dim(e.a), dim(e.b))
        const g = ctx.createRadialGradient(x, y, 0, x, y, 9 * sc)
        g.addColorStop(0, p.hue); g.addColorStop(0.35, p.hue + "88"); g.addColorStop(1, p.hue + "00")
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 9 * sc, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(x, y, 1.6 * sc, 0, Math.PI * 2); ctx.fill()
      }

      // 노드 (뒤 → 앞)
      const nodesSorted = [...s.nodes].sort((p, q) => q.zz - p.zz)
      for (const n of nodesSorted) {
        const m = metrics.get(n.id)
        if (!m) continue
        // 소스 노드는 감독자 상태가 우선: degraded 앰버, failed/broken 빨강 (실패 중 펄스)
        const src = s.sourceStatus[n.id]
        const color = src === "degraded" ? "#fbbf24" : src === "failed" || src === "broken" ? "#ef4444" : src === "paused" ? "#6b7280" : STATUS_COLOR[m.metrics.status]
        const failing = src === "degraded" || src === "failed" || src === "broken"
        const r = 13 * n.s * (failing ? 1 + 0.08 * Math.sin(now / 160) : 1)
        const bl = blurFor(n.zz)
        ctx.filter = bl > 0.5 ? `blur(${bl.toFixed(1)}px)` : "none"
        ctx.globalAlpha = dim(n.id) * (1 - Math.min(0.45, bl / 8))
        if (m.metrics.status === "active") {
          const g = ctx.createRadialGradient(n.sx, n.sy, r * 0.4, n.sx, n.sy, r * 3.2)
          g.addColorStop(0, "rgba(163,230,53,0.35)"); g.addColorStop(1, "rgba(163,230,53,0)")
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.sx, n.sy, r * 3.2, 0, Math.PI * 2); ctx.fill()
        }
        ctx.fillStyle = "#0b0f0b"; ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2); ctx.fill()
        ctx.lineWidth = (n.id === s.selected ? 2.2 : 1.4) * n.s; ctx.strokeStyle = n.id === s.selected ? "#f0fdf4" : color
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2); ctx.stroke()
        ctx.fillStyle = color; ctx.font = `600 ${Math.max(6, 7.5 * n.s)}px ui-monospace, SFMono-Regular, monospace`; ctx.textAlign = "center"
        ctx.fillText(STAGE_TAG[n.stage], n.sx, n.sy + 2.5 * n.s)
        if (failing) { ctx.fillStyle = color; ctx.font = `700 ${9 * n.s}px ui-monospace, monospace`; ctx.textAlign = "left"; ctx.fillText(src === "broken" ? "BROKEN · retrying" : src === "failed" ? "FAILED · backoff" : "DEGRADED · retry", n.sx + r + 8 * n.s, n.sy - 20 * n.s) }
        // 라벨 블록: id(굵게) / name(흐리게) / 처리량·레이턴시 / 상태
        const lx = n.sx + r + 8 * n.s
        ctx.textAlign = "left"
        ctx.fillStyle = "#e5efe5"; ctx.font = `700 ${12 * n.s}px ui-monospace, SFMono-Regular, monospace`
        ctx.fillText(n.id, lx, n.sy - 8 * n.s)
        ctx.fillStyle = "#6b7a6b"; ctx.font = `${10 * n.s}px ui-monospace, SFMono-Regular, monospace`
        ctx.fillText(m.name, lx, n.sy + 4 * n.s)
        ctx.fillStyle = "#8fa38f"; ctx.font = `${10 * n.s}px ui-monospace, SFMono-Regular, monospace`
        ctx.fillText(`${fmtRate(m.metrics.throughputPerSec)} · ${m.metrics.avgLatencyMs.toFixed(2)}ms`, lx, n.sy + 16 * n.s)
        ctx.fillStyle = color; ctx.font = `700 ${9.5 * n.s}px ui-monospace, SFMono-Regular, monospace`
        ctx.fillText(STATUS_LABEL[m.metrics.status], lx, n.sy + 28 * n.s)
      }
      ctx.filter = "none"; ctx.globalAlpha = 1

      // 호버 카드
      if (s.hover) {
        const n = byId.get(s.hover); const m = metrics.get(s.hover)
        if (n && m) {
          const lines = [`${STAGE_TAG[n.stage]}.${n.id}`, `${STATUS_LABEL[m.metrics.status]} · ${m.metrics.totalMsgs.toLocaleString()} msgs · last ${m.metrics.lastLatencyMs.toFixed(2)}ms`, m.metrics.lastRunAt ? `last run ${new Date(m.metrics.lastRunAt).toLocaleTimeString("ko-KR", { hour12: false })}` : "never ran", ...(m.metrics.lastError ? [`error: ${m.metrics.lastError.slice(0, 60)}`] : [])]
          ctx.font = "10px ui-monospace, SFMono-Regular, monospace"
          const wdt = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20
          const x = Math.min(w - wdt - 8, n.sx + 24), y = Math.min(h - 14 * lines.length - 16, n.sy + 20)
          ctx.fillStyle = "rgba(10,13,10,0.92)"; ctx.strokeStyle = "#2a332a"; ctx.lineWidth = 1
          ctx.beginPath(); ctx.roundRect(x, y, wdt, 12 + 14 * lines.length, 4); ctx.fill(); ctx.stroke()
          ctx.textAlign = "left"
          lines.forEach((l, i) => { ctx.fillStyle = i === 0 ? "#d9f99d" : i === 3 ? "#fca5a5" : "#b7c4b7"; ctx.font = i === 0 ? "700 10px ui-monospace, monospace" : "10px ui-monospace, monospace"; ctx.fillText(l, x + 10, y + 16 + 14 * i) })
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const pos = (ev: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top } }
    const hit = (x: number, y: number) => {
      let best: N3 | null = null, bd = Infinity
      for (const n of s.nodes) { const d = Math.hypot(n.sx - x, n.sy - y); if (d < 16 * n.s + 6 && d < bd) { best = n; bd = d } }
      return best
    }
    const onDown = (ev: PointerEvent) => { const { x, y } = pos(ev); s.drag = { x, y, yaw: s.cam.yaw, pitch: s.cam.pitch, panX: s.cam.panX, panY: s.cam.panY, moved: false, pan: ev.shiftKey || ev.button === 1 }; canvas.setPointerCapture(ev.pointerId) }
    const onMove = (ev: PointerEvent) => {
      const { x, y } = pos(ev)
      if (s.drag) {
        const dx = x - s.drag.x, dy = y - s.drag.y
        if (Math.hypot(dx, dy) > 3) s.drag.moved = true
        if (s.drag.pan || s.mode === "flat") { s.cam.panX = s.drag.panX + dx; s.cam.panY = s.drag.panY + dy }
        else { s.cam.yaw = s.drag.yaw + dx * 0.005; s.cam.pitch = Math.max(-0.9, Math.min(0.9, s.drag.pitch + dy * 0.005)) }
        return
      }
      const n = hit(x, y)
      const id = n?.id ?? null
      if (id !== s.hover) { s.hover = id; setHover(id); canvas.style.cursor = id ? "pointer" : "grab" }
    }
    const onUp = (ev: PointerEvent) => {
      const { x, y } = pos(ev)
      if (s.drag && !s.drag.moved) { const n = hit(x, y); onSelect(n ? (n.id === s.selected ? null : n.id) : null) }
      s.drag = null
    }
    const onWheel = (ev: WheelEvent) => { ev.preventDefault(); s.cam.zoom = Math.min(2.6, Math.max(0.5, s.cam.zoom * Math.exp(-ev.deltaY * 0.0012))) }
    canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove); canvas.addEventListener("pointerup", onUp); canvas.addEventListener("wheel", onWheel, { passive: false })
    canvas.style.cursor = "grab"
    return () => { cancelAnimationFrame(raf); ro.disconnect(); canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove); canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("wheel", onWheel) }
  }, [onSelect])

  useEffect(() => { st.current.cam = { yaw: -0.22, pitch: 0.16, zoom: 1, panX: 0, panY: 0 } }, [mode, resetKey])

  return (
    <div className="relative h-full w-full" style={{ height }}>
      <canvas ref={canvasRef} className="block h-full w-full touch-none" role="img" aria-label={`파이프라인 그래프 — ${hover ?? "노드 없음"} 호버`} />
    </div>
  )
}

export function resetCameraHint() {
  return "drag to orbit · shift-drag to pan · scroll to zoom · one light is one real micro-batch · parallel branches separate in depth"
}
