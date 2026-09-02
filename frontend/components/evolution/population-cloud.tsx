"use client"

import { useEffect, useRef, useState } from "react"
import type { EvoAgent } from "@/lib/api"

/**
 * 개체군 구름 — 릴의 MAP 뷰. 점 하나 = 개체 하나. 원형(archetype)별로 군집을 이루고,
 * 색은 적합도(어두운 빨강 → 주황 → 노랑), 크기는 자본, 죽은 개체는 회색 잔상.
 * 위치는 결정적(id 해시)이라 새로고침해도 같은 자리에 있다.
 */
const CLUSTER_ORDER = ["MOMENTUM_SPRINTER", "TREND_RIDER", "REGIME_GATED", "DIVERSIFIER", "CONCENTRATOR", "FUND_OF_AGENTS", "LOW_VOL", "BALANCED"]

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}

export function fitnessColor(f: number | null, alive: boolean): string {
  if (!alive) return "#3a3f3a"
  if (f === null) return "#7f1d1d"
  const x = Math.max(0, Math.min(1, (f + 1) / 5)) // -1..4 → 0..1
  const r = 220, g = Math.round(40 + 190 * x), b = Math.round(30 + 40 * (1 - x))
  // hex로 돌려준다 — 호출부가 "aa"/"00" 알파를 뒤에 붙인다
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

export function PopulationCloud({ agents, selected, onSelect, height = 460 }: { agents: EvoAgent[]; selected: string | null; onSelect: (id: string | null) => void; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const st = useRef({ agents, selected, hover: null as string | null, pts: [] as Array<{ id: string; x: number; y: number; r: number }>, w: 0, h: 0, t: 0 })
  const [hover, setHover] = useState<EvoAgent | null>(null)
  st.current.agents = agents
  st.current.selected = selected

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")!
    const s = st.current
    let raf = 0
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const r = canvas.getBoundingClientRect()
      s.w = r.width; s.h = r.height
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize); ro.observe(canvas)

    const draw = (now: number) => {
      s.t = now / 1000
      const { w, h } = s
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = "#08060a"; ctx.fillRect(0, 0, w, h)
      const vg = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.7)
      vg.addColorStop(0, "rgba(220,38,38,0.07)"); vg.addColorStop(1, "rgba(0,0,0,0)")
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h)

      // 군집 중심 — 원형별로 큰 원 둘레에 배치
      const clusters = CLUSTER_ORDER.filter((c) => s.agents.some((a) => a.archetype === c))
      const centers = new Map<string, { x: number; y: number }>()
      clusters.forEach((c, i) => {
        const ang = (i / Math.max(1, clusters.length)) * Math.PI * 2 - Math.PI / 2
        const R = Math.min(w, h) * 0.32
        centers.set(c, { x: w / 2 + Math.cos(ang) * R, y: h / 2 + Math.sin(ang) * R })
      })
      const maxCap = Math.max(1, ...s.agents.filter((a) => a.alive).map((a) => a.capitalKrw))
      s.pts = []
      const alive = s.agents.filter((a) => a.alive)
      const dead = s.agents.filter((a) => !a.alive)
      const place = (a: EvoAgent) => {
        const c = centers.get(a.archetype) ?? { x: w / 2, y: h / 2 }
        const n = s.agents.filter((x) => x.archetype === a.archetype).length
        const spread = 40 + Math.sqrt(n) * 18
        const u = hash(a.id), v = hash(a.id + "y")
        const rr = Math.sqrt(u) * spread
        const ang = v * Math.PI * 2 + (a.alive ? Math.sin(s.t * 0.4 + u * 6) * 0.05 : 0)
        return { x: c.x + Math.cos(ang) * rr, y: c.y + Math.sin(ang) * rr }
      }
      // 군집 라벨
      ctx.font = "600 10px ui-monospace, monospace"; ctx.textAlign = "center"
      for (const c of clusters) {
        const p = centers.get(c)!
        const n = alive.filter((a) => a.archetype === c).length
        ctx.fillStyle = "#c98a8a"; ctx.fillText(c, p.x, p.y - 44 - Math.sqrt(s.agents.filter((x) => x.archetype === c).length) * 18)
        ctx.fillStyle = "#7a4a4a"; ctx.font = "9px ui-monospace, monospace"; ctx.fillText(String(n), p.x, p.y - 33 - Math.sqrt(s.agents.filter((x) => x.archetype === c).length) * 18)
        ctx.font = "600 10px ui-monospace, monospace"
      }
      // 동료 위탁 흐름 — 선택/호버 개체에서 동료로 가는 선
      const focus = s.hover ?? s.selected
      if (focus) {
        const a = s.agents.find((x) => x.id === focus)
        if (a?.alive) {
          const pa = place(a)
          for (const pid of a.peers) {
            const p = s.agents.find((x) => x.id === pid); if (!p?.alive) continue
            const pp = place(p)
            ctx.strokeStyle = "rgba(251,191,36,0.55)"; ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pp.x, pp.y); ctx.stroke()
            const t = (s.t * 0.5 + hash(pid)) % 1
            ctx.fillStyle = "#fde68a"; ctx.beginPath(); ctx.arc(pa.x + (pp.x - pa.x) * t, pa.y + (pp.y - pa.y) * t, 2, 0, Math.PI * 2); ctx.fill()
          }
        }
      }
      // 죽은 개체 — 회색 잔상
      for (const a of dead) { const p = place(a); ctx.fillStyle = "#2d2a2e"; ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2); ctx.fill() }
      // 생존 개체
      for (const a of alive) {
        const p = place(a)
        const r = 2.2 + 6 * Math.sqrt(a.capitalKrw / maxCap)
        const col = fitnessColor(a.exam?.fitness ?? null, true)
        const isF = focus === a.id
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3)
        g.addColorStop(0, col + "aa"); g.addColorStop(1, col + "00")
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill()
        if (isF) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2); ctx.stroke() }
        s.pts.push({ id: a.id, x: p.x, y: p.y, r })
      }
      // 호버 카드
      if (s.hover) {
        const a = s.agents.find((x) => x.id === s.hover); const pt = s.pts.find((x) => x.id === s.hover)
        if (a && pt) {
          const lines = [`${a.name} · ${a.archetype}`, a.exam ? `${a.exam.totalReturnPct >= 0 ? "+" : ""}${a.exam.totalReturnPct}%  DD ${a.exam.maxDrawdownPct}%  sharpe ${a.exam.sharpe}` : "not examined yet", `₩${Math.round(a.capitalKrw).toLocaleString()} · gen ${a.generationBorn}${a.parents.length ? " · child" : " · genesis"}`]
          ctx.font = "10px ui-monospace, monospace"
          const wdt = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 18
          const x = Math.min(w - wdt - 6, pt.x + 12), y = Math.max(6, pt.y - 52)
          ctx.fillStyle = "rgba(20,8,10,0.94)"; ctx.strokeStyle = "#7f1d1d"; ctx.lineWidth = 1
          ctx.beginPath(); ctx.roundRect(x, y, wdt, 46, 4); ctx.fill(); ctx.stroke()
          ctx.textAlign = "left"
          ctx.fillStyle = "#fecaca"; ctx.font = "700 10px ui-monospace, monospace"; ctx.fillText(lines[0], x + 9, y + 14)
          ctx.fillStyle = (a.exam?.totalReturnPct ?? 0) >= 0 ? "#86efac" : "#fca5a5"; ctx.font = "10px ui-monospace, monospace"; ctx.fillText(lines[1], x + 9, y + 27)
          ctx.fillStyle = "#c98a8a"; ctx.fillText(lines[2], x + 9, y + 40)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    const pos = (ev: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top } }
    const hit = (x: number, y: number) => { let best: { id: string; d: number } | null = null; for (const p of s.pts) { const d = Math.hypot(p.x - x, p.y - y); if (d < p.r + 6 && (!best || d < best.d)) best = { id: p.id, d } } return best?.id ?? null }
    const onMove = (ev: PointerEvent) => { const { x, y } = pos(ev); const id = hit(x, y); if (id !== s.hover) { s.hover = id; setHover(s.agents.find((a) => a.id === id) ?? null); canvas.style.cursor = id ? "pointer" : "default" } }
    const onClick = (ev: PointerEvent) => { const { x, y } = pos(ev); onSelect(hit(x, y)) }
    canvas.addEventListener("pointermove", onMove); canvas.addEventListener("pointerup", onClick)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); canvas.removeEventListener("pointermove", onMove); canvas.removeEventListener("pointerup", onClick) }
  }, [onSelect])

  return (
    <div className="relative" style={{ height }}>
      <canvas ref={ref} className="block h-full w-full" role="img" aria-label={`개체군 구름 — ${hover ? hover.name : "호버 없음"}`} />
    </div>
  )
}

/** 캠페인 세대 곡선 — 생존 개체마다 적합도 이력 한 줄 (릴의 CAMPAIGN GENERATIONS) */
export function GenerationCurves({ agents, history, height = 180 }: { agents: EvoAgent[]; history: Array<{ gen: number; topFitness: number; meanFitness: number }>; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return
    const ctx = canvas.getContext("2d")!
    const dpr = window.devicePixelRatio || 1
    const r = canvas.getBoundingClientRect()
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const w = r.width, h = r.height
    ctx.fillStyle = "#08060a"; ctx.fillRect(0, 0, w, h)
    const gens = history.map((x) => x.gen)
    if (gens.length === 0) { ctx.fillStyle = "#7a4a4a"; ctx.font = "10px ui-monospace, monospace"; ctx.fillText("no generations yet", 12, 20); return }
    const g0 = Math.min(...gens), g1 = Math.max(...gens)
    const vals = agents.flatMap((a) => a.fitnessHistory.map((p) => p.fitness)).concat(history.map((x) => x.topFitness), history.map((x) => x.meanFitness))
    const lo = Math.min(...vals, -1), hi = Math.max(...vals, 1)
    const X = (g: number) => 30 + ((g - g0) / Math.max(1, g1 - g0)) * (w - 40)
    const Y = (v: number) => h - 16 - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - 30)
    ctx.strokeStyle = "#2a1a1e"; ctx.lineWidth = 1
    for (const v of [0]) { ctx.beginPath(); ctx.moveTo(30, Y(v)); ctx.lineTo(w - 10, Y(v)); ctx.stroke() }
    ctx.fillStyle = "#7a4a4a"; ctx.font = "9px ui-monospace, monospace"; ctx.textAlign = "right"
    ctx.fillText(hi.toFixed(1), 26, Y(hi) + 3); ctx.fillText(lo.toFixed(1), 26, Y(lo) + 3); ctx.fillText("0", 26, Y(0) + 3)
    for (const a of agents) {
      if (a.fitnessHistory.length < 1) continue
      ctx.strokeStyle = a.alive ? fitnessColor(a.exam?.fitness ?? null, true) + "99" : "#3a3f3a80"; ctx.lineWidth = a.alive ? 1.2 : 0.8
      ctx.beginPath()
      a.fitnessHistory.forEach((p, i) => { const x = X(p.gen), y = Y(p.fitness); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) })
      ctx.stroke()
      const last = a.fitnessHistory[a.fitnessHistory.length - 1]
      ctx.fillStyle = a.alive ? fitnessColor(a.exam?.fitness ?? null, true) : "#3a3f3a"; ctx.beginPath(); ctx.arc(X(last.gen), Y(last.fitness), 1.8, 0, Math.PI * 2); ctx.fill()
    }
    ctx.strokeStyle = "#fde68a"; ctx.lineWidth = 1.6; ctx.beginPath(); history.forEach((x, i) => { const px = X(x.gen), py = Y(x.topFitness); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py) }); ctx.stroke()
    ctx.strokeStyle = "#f87171"; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.beginPath(); history.forEach((x, i) => { const px = X(x.gen), py = Y(x.meanFitness); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py) }); ctx.stroke(); ctx.setLineDash([])
    ctx.fillStyle = "#c98a8a"; ctx.textAlign = "left"; ctx.font = "9px ui-monospace, monospace"
    ctx.fillText(`gen ${g0}`, 30, h - 4); ctx.textAlign = "right"; ctx.fillText(`gen ${g1}`, w - 10, h - 4)
    ctx.textAlign = "left"; ctx.fillStyle = "#fde68a"; ctx.fillText("— top", w - 90, 12); ctx.fillStyle = "#f87171"; ctx.fillText("- - mean", w - 50, 12)
  }, [agents, history])
  return <canvas ref={ref} className="block w-full" style={{ height }} role="img" aria-label="세대별 적합도 곡선" />
}
