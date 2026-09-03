"use client"

import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { Check, Gavel, OctagonX, Pause, Play, RefreshCw, X } from "lucide-react"
import {
  ApiError,
  approveDecision,
  arbitrateNow,
  getControl,
  isBackendNotConfigured,
  pauseControl,
  rejectDecision,
  resumeControl,
  setControlPolicy,
  setAutopilot,
  setEngine,
  type ControlDecision,
  type ControlEngine,
  type ControlStatus,
} from "@/lib/api"
import { useLiveChannel } from "@/hooks/useLiveSocket"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { cn } from "@/lib/utils"

/**
 * COMMAND CENTER — 대시보드 홈의 통합 제어 평면.
 *
 * 스캐너·오피스·진화·파이프라인 네 엔진은 더 이상 각자 장부를 건드리지 않는다.
 * 전부 제안(proposal)만 내고, 중재기(arbiter)가 가중 혼합 → 제약 → 한 개의
 * 목표 포트폴리오로 만든 뒤 오토파일럿이거나 운영자가 승인해야만 페이퍼
 * 장부가 회전한다. 이 화면의 숫자는 전부 GET /control 실상태다.
 */

const krw = (v: number) => `₩${Math.round(v).toLocaleString("ko-KR")}`
const tm = (s: string) => new Date(s).toLocaleTimeString("ko-KR", { hour12: false })
const ago = (s: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(s)) / 60_000))
  return m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`
}
const sym = (m: string) => m.replace("KRW-", "")

const ENGINE_COLOR: Record<ControlEngine["id"], string> = {
  office: "#a78bfa",
  evolution: "#f87171",
  signals: "#34d399",
}
const MANAGER_COLOR: Record<string, string> = { ...ENGINE_COLOR, sentiment: "#f472b6", risk: "#fbbf24" }
const MODE_KO: Record<"quorum" | "weighted", string> = { quorum: "정족수제", weighted: "비례제" }
const STANCE_CLASS: Record<string, string> = { SUPPORT: "text-emerald-300", OPPOSE: "text-rose-300", ABSTAIN: "text-zinc-500", VETO: "text-rose-400 font-bold" }
const STATUS_KO: Record<ControlDecision["status"], string> = {
  pending: "승인 대기",
  executed: "집행",
  rejected: "거부",
  skipped: "건너뜀",
  blocked: "차단",
}
const STATUS_CLASS: Record<ControlDecision["status"], string> = {
  pending: "border-amber-400/50 text-amber-300",
  executed: "border-emerald-400/50 text-emerald-300",
  rejected: "border-rose-400/50 text-rose-300",
  skipped: "border-zinc-500/50 text-zinc-400",
  blocked: "border-rose-500/70 text-rose-400",
}

export function useControl() {
  const swr = useSWR("control", () => getControl(), { refreshInterval: 15_000 })
  useLiveChannel(["control", "control:decision"], (msg) => {
    if (msg.ch === "control") void swr.mutate(msg.data as ControlStatus, { revalidate: false })
    else if (msg.ch === "control:decision") {
      const d = msg.data as ControlDecision
      if (d.status === "executed") toast.success(`제어 평면 집행 — ${d.execution?.orders ?? 0}건 (${d.by === "autopilot" ? "오토파일럿" : "운영자"})`)
      else if (d.status === "pending") toast(`승인 대기 결정 — 회전율 ${d.turnoverPct.toFixed(1)}%`)
      void swr.mutate()
    }
  })
  return swr
}

function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "로그인이 필요합니다 (설정 · 키 → 로그인)"
    return e.message
  }
  return e instanceof Error ? e.message : "실패"
}

/** 시스템 맵 — 소스 → 파이프라인 → 엔진 → 중재기 → 장부. 살아있는 것만 밝다. */
function SystemMap({ s }: { s: ControlStatus }) {
  const W = 760, H = 250
  const col = { src: 70, pipe: 230, eng: 400, arb: 570, led: 700 }
  const engines = s.engines
  const engY = (i: number) => 40 + i * 56
  const arbY = 125
  const activeProposals = new Set(s.proposals.map((p) => p.engine))
  const sources = [
    { id: "upbit", label: "Upbit", y: 70 },
    { id: "yahoo", label: "Yahoo", y: 125 },
    { id: "news", label: "News/RSS", y: 180 },
  ]
  const pipes = [
    { id: "regime", label: "HMM 국면", y: 70 },
    { id: "garch", label: "GARCH σ", y: 125 },
    { id: "dag", label: "신호 DAG", y: 180 },
  ]
  const lastExec = s.decisions.find((d) => d.status === "executed")
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[640px] w-full" role="img" aria-label="제어 평면 시스템 맵">
        <defs>
          <style>{`@keyframes cc-flow{to{stroke-dashoffset:-24}} .cc-live{stroke-dasharray:6 6;animation:cc-flow 1.2s linear infinite}`}</style>
        </defs>
        {/* 소스 → 파이프라인 */}
        {sources.map((src) => pipes.map((p) => (
          <line key={`${src.id}-${p.id}`} x1={col.src + 46} y1={src.y} x2={col.pipe - 46} y2={p.y} stroke="currentColor" className="text-border" strokeWidth="1" opacity="0.6" />
        )))}
        {/* 파이프라인 → 엔진 */}
        {pipes.map((p) => engines.map((e, i) => (
          <line key={`${p.id}-${e.id}`} x1={col.pipe + 46} y1={p.y} x2={col.eng - 52} y2={engY(i)} stroke={e.enabled ? ENGINE_COLOR[e.id] : "currentColor"} className={cn(!e.enabled && "text-border")} strokeWidth="1" opacity={e.enabled ? 0.35 : 0.25} />
        )))}
        {/* 엔진 → 중재기 (제안이 살아있으면 흐름 애니메이션) */}
        {engines.map((e, i) => (
          <path key={`arb-${e.id}`} d={`M${col.eng + 52},${engY(i)} C${col.eng + 110},${engY(i)} ${col.arb - 110},${arbY} ${col.arb - 44},${arbY}`} fill="none" stroke={e.enabled ? ENGINE_COLOR[e.id] : "currentColor"} className={cn(!e.enabled && "text-border", e.enabled && activeProposals.has(e.id) && "cc-live")} strokeWidth={e.enabled ? 1 + e.share * 3 : 1} opacity={e.enabled ? 0.85 : 0.25} />
        ))}
        {/* 중재기 → 장부 */}
        <line x1={col.arb + 44} y1={arbY} x2={col.led - 40} y2={arbY} stroke={s.killSwitch ? "#f43f5e" : s.autopilot ? "#34d399" : "#fbbf24"} strokeWidth="2" className={cn(s.pending && !s.killSwitch && "cc-live")} />
        {/* 노드 */}
        {sources.map((src) => (
          <g key={src.id} transform={`translate(${col.src},${src.y})`}>
            <rect x={-46} y={-14} width={92} height={28} rx={6} className="fill-card stroke-border" strokeWidth="1" />
            <text textAnchor="middle" y={4} className="fill-foreground" fontSize="11">{src.label}</text>
          </g>
        ))}
        {pipes.map((p) => (
          <g key={p.id} transform={`translate(${col.pipe},${p.y})`}>
            <rect x={-46} y={-14} width={92} height={28} rx={6} className="fill-card stroke-border" strokeWidth="1" />
            <text textAnchor="middle" y={4} className="fill-foreground" fontSize="11">{p.label}</text>
          </g>
        ))}
        {engines.map((e, i) => (
          <g key={e.id} transform={`translate(${col.eng},${engY(i)})`} opacity={e.enabled ? 1 : 0.45}>
            <rect x={-52} y={-16} width={104} height={32} rx={6} className="fill-card" stroke={ENGINE_COLOR[e.id]} strokeWidth={e.enabled ? 1.5 : 1} />
            <text textAnchor="middle" y={-2} className="fill-foreground" fontSize="11" fontWeight={600}>{e.nameKo}</text>
            <text textAnchor="middle" y={11} fontSize="9" fill={ENGINE_COLOR[e.id]} fontFamily="ui-monospace, monospace">
              {e.enabled ? `${(e.share * 100).toFixed(0)}% · ${e.lastProposal ? `c${e.lastProposal.confidence.toFixed(2)}` : "제안 없음"}` : "OFF"}
            </text>
          </g>
        ))}
        <g transform={`translate(${col.arb},${arbY})`}>
          <circle r={40} className="fill-card" stroke={s.killSwitch ? "#f43f5e" : "#fbbf24"} strokeWidth="1.5" />
          <text textAnchor="middle" y={-6} className="fill-foreground" fontSize="11" fontWeight={700}>중재기</text>
          <text textAnchor="middle" y={8} fontSize="9" className="fill-muted-foreground" fontFamily="ui-monospace, monospace">{s.proposals.length} 제안</text>
          <text textAnchor="middle" y={20} fontSize="9" fill={s.killSwitch ? "#f43f5e" : s.autopilot ? "#34d399" : "#fbbf24"} fontFamily="ui-monospace, monospace">{s.killSwitch ? "KILL" : s.autopilot ? "AUTO" : "승인제"}</text>
        </g>
        <g transform={`translate(${col.led},${arbY})`}>
          <rect x={-40} y={-30} width={80} height={60} rx={8} className="fill-card stroke-border" strokeWidth="1" />
          <text textAnchor="middle" y={-12} className="fill-foreground" fontSize="11" fontWeight={600}>{s.mode === "paper" ? "페이퍼 장부" : "장부"}</text>
          <text textAnchor="middle" y={4} fontSize="9" className="fill-muted-foreground" fontFamily="ui-monospace, monospace">{s.holdings.length} 종목</text>
          <text textAnchor="middle" y={18} fontSize="9" className="fill-muted-foreground" fontFamily="ui-monospace, monospace">{lastExec ? ago(lastExec.ts) : "집행 없음"}</text>
        </g>
      </svg>
    </div>
  )
}

function EngineRow({ e, onChange }: { e: ControlEngine; onChange: (patch: { enabled?: boolean; weight?: number }) => Promise<void> }) {
  const [w, setW] = useState<number | null>(null)
  const weight = w ?? e.weight
  return (
    <div className={cn("rounded-lg border border-border p-3", !e.enabled && "opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: ENGINE_COLOR[e.id] }} aria-hidden="true" />
          <span className="text-sm font-semibold">{e.nameKo}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{e.name}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={e.enabled}
          aria-label={`${e.nameKo} 협의회 참여`}
          title={e.enabled ? "클릭하면 협의회에서 제외한다" : "클릭하면 협의회에 다시 참여시킨다"}
          onClick={() => void onChange({ enabled: !e.enabled })}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold"
        >
          <span className={cn("relative inline-block h-4 w-7 rounded-full transition-colors", e.enabled ? "bg-emerald-500" : "bg-muted")}><span className={cn("absolute top-0.5 size-3 rounded-full bg-background transition-all", e.enabled ? "left-3.5" : "left-0.5")} /></span>
          <span className={e.enabled ? "text-emerald-300" : "text-muted-foreground"}>{e.enabled ? "참여" : "제외"}</span>
        </button>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{e.description}</p>
      <div className="mt-2 grid grid-cols-4 gap-2 font-mono text-[11px] tnum">
        <div><span className="text-muted-foreground">지분 </span>{(e.share * 100).toFixed(0)}%</div>
        <div><span className="text-muted-foreground">누적 </span><span className={e.cumReturnPct > 0 ? "text-emerald-300" : e.cumReturnPct < 0 ? "text-rose-300" : ""}>{e.cumReturnPct >= 0 ? "+" : ""}{e.cumReturnPct.toFixed(2)}%</span></div>
        <div title="5분 마크 중 양의 구간 비율"><span className="text-muted-foreground">타율 </span>{e.hitRate === null ? "—" : `${(e.hitRate * 100).toFixed(0)}%`}<span className="text-muted-foreground"> /{e.marks ?? 0}</span></div>
        <div><span className="text-muted-foreground">제안 </span>{e.proposals}회</div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <label className="whitespace-nowrap text-[10px] text-muted-foreground" htmlFor={`w-${e.id}`}>가중</label>
        <input id={`w-${e.id}`} type="range" min={0.05} max={5} step={0.05} value={weight} onChange={(ev) => setW(Number(ev.target.value))} onMouseUp={() => { if (w !== null) { void onChange({ weight: w }); setW(null) } }} onTouchEnd={() => { if (w !== null) { void onChange({ weight: w }); setW(null) } }} onKeyUp={() => { if (w !== null) { void onChange({ weight: w }); setW(null) } }} className="w-full accent-current" style={{ color: ENGINE_COLOR[e.id] }} />
        <span className="w-10 text-right font-mono text-[11px] tnum">{weight.toFixed(2)}</span>
      </div>
      {e.lastProposal ? (
        <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={e.lastProposal.evidence}>
          {ago(e.lastProposal.ts)} · {e.lastProposal.targets.length}종목 · 확신 {e.lastProposal.confidence.toFixed(2)} · {e.lastProposal.evidence}
        </p>
      ) : (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">아직 제안 없음</p>
      )}
    </div>
  )
}

function DecisionCard({ d, pending, onApprove, onReject, busy, auto }: { d: ControlDecision; pending?: boolean; onApprove?: () => void; onReject?: () => void; busy?: boolean; auto?: { nextEligibleAt: string | null; everyMin: number } | null }) {
  const [open, setOpen] = useState(Boolean(pending))
  return (
    <div className={cn("rounded-lg border p-3", pending ? "border-amber-400/60 bg-amber-400/5" : "border-border")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", STATUS_CLASS[d.status])}>{STATUS_KO[d.status]}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{tm(d.ts)}</span>
          {d.by && <span className="font-mono text-[10px] text-muted-foreground">{d.by === "autopilot" ? "오토파일럿" : "운영자"}</span>}
        </div>
        <div className="flex items-center gap-1 font-mono text-[11px] tnum">
          {d.contributions.map((c) => (
            <span key={c.engine} className="rounded px-1" style={{ color: ENGINE_COLOR[c.engine], background: `${ENGINE_COLOR[c.engine]}22` }}>{c.engine} {(c.weight * 100).toFixed(0)}%</span>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {d.targets.map((t) => (
          <span key={t.market} className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] tnum">{sym(t.market)} {t.weightPct.toFixed(1)}%</span>
        ))}
        <span className="rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[11px] tnum text-muted-foreground">현금 {d.cashPct.toFixed(1)}%</span>
        <span className="ml-auto font-mono text-[11px] tnum text-muted-foreground">회전율 {d.turnoverPct.toFixed(1)}%{d.execution ? ` · 주문 ${d.execution.orders}건` : ""}{d.execution?.error ? ` · ${d.execution.error}` : ""}{d.outcome ? <span className={cn("ml-1", d.outcome.pct > 0 ? "text-emerald-300" : d.outcome.pct < 0 ? "text-rose-300" : "")}> · 결과 {d.outcome.pct >= 0 ? "+" : ""}{d.outcome.pct.toFixed(2)}%{d.outcome.closedAt ? "" : " (진행)"}</span> : null}</span>
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:underline">
        {open ? "근거 접기" : `근거 ${d.rationale.length}줄 · 제약 ${d.constraints.length}건`}
      </button>
      {open && d.council && (
        <div className="mt-2 rounded-md border border-border/70 bg-muted/20 p-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">협의록 · {d.council.quorumMet ? "채택 있음" : "채택 없음 — 보유 유지"}</p>
          {d.shadow && <p className="mt-0.5 font-mono text-[10px] text-muted-foreground" title={d.shadow.summary.join(" / ")}>그림자 · {MODE_KO[d.shadow.mode]}였다면: {d.shadow.targets.length ? d.shadow.targets.map((t) => `${sym(t.market)} ${t.weightPct}%`).join(" · ") : "채택 없음"} · 현금 {d.shadow.cashPct}%</p>}
          <div className="mt-1 flex flex-wrap gap-1">
            {d.council.tally.map((t) => (
              <span key={t.market} className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px]", t.outcome === "ADOPTED" ? "border-emerald-400/50 text-emerald-300" : t.outcome === "REJECTED" ? "border-rose-400/50 text-rose-300" : "border-border text-muted-foreground")} title={t.why}>
                {sym(t.market)} {t.outcome === "ADOPTED" ? `${t.weightPct}%` : t.outcome} · {t.supporters.join("+") || "—"}{t.opposers.length ? ` vs ${t.opposers.join("+")}` : ""}
              </span>
            ))}
          </div>
          {d.council.rounds.map((r) => (
            <details key={r.round} className="mt-1">
              <summary className="cursor-pointer text-[10px] text-muted-foreground">R{r.round} {r.title} · {r.positions.length ? `${r.positions.length}건` : `${r.notes.length}줄`}</summary>
              <ul className="mt-0.5 space-y-0.5 font-mono text-[10px]">
                {r.positions.map((p, i) => (
                  <li key={i} className="flex gap-1.5"><span className="shrink-0" style={{ color: MANAGER_COLOR[p.manager] }}>{p.manager}</span><span className="shrink-0 text-muted-foreground">{sym(p.market)}</span><span className={cn("shrink-0", STANCE_CLASS[p.stance])}>{p.stance}{p.weightPct !== null ? ` ${p.weightPct}%` : ""}</span><span className="truncate text-muted-foreground" title={p.reason}>{p.reason}</span></li>
                ))}
                {r.notes.map((n, i) => <li key={`n${i}`} className="text-amber-300/80">· {n}</li>)}
              </ul>
            </details>
          ))}
        </div>
      )}
      {open && (
        <div className="mt-1 grid gap-2 md:grid-cols-2">
          <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
            {d.rationale.map((r, i) => <li key={i}>· {r}</li>)}
          </ul>
          <ul className="space-y-0.5 font-mono text-[10px] text-amber-300/80">
            {d.constraints.length === 0 ? <li>제약 발동 없음</li> : d.constraints.map((r, i) => <li key={i}>⚠ {r}</li>)}
            {d.execution?.skipped.length ? <li className="text-muted-foreground">건너뜀: {d.execution.skipped.join(", ")}</li> : null}
          </ul>
        </div>
      )}
      {pending && auto && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/40 px-2.5 py-1.5 text-emerald-300"><Play className="size-3.5" aria-hidden="true" /> 자동 집행 예정 — {auto.nextEligibleAt ? (Date.parse(auto.nextEligibleAt) > Date.now() ? `${Math.max(1, Math.ceil((Date.parse(auto.nextEligibleAt) - Date.now()) / 60_000))}분 뒤 (집행 간격)` : `다음 ${auto.everyMin}분 틱에`) : `다음 ${auto.everyMin}분 틱에`} 스케줄러가 집행한다. 손댈 것 없음.</span>
          <button type="button" disabled={busy} onClick={onApprove} className="rounded-md border border-border px-2.5 py-1.5 text-muted-foreground disabled:opacity-50" title="간격을 기다리지 않고 지금 집행 (선택)">지금 집행 (선택)</button>
        </div>
      )}
      {pending && !auto && (
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={busy} onClick={onApprove} className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50"><Check className="size-3.5" aria-hidden="true" /> 승인 · 페이퍼 집행</button>
          <button type="button" disabled={busy} onClick={onReject} className="inline-flex items-center gap-1 rounded-md border border-rose-400/60 px-3 py-1.5 text-xs font-semibold text-rose-300 disabled:opacity-50"><X className="size-3.5" aria-hidden="true" /> 거부</button>
        </div>
      )}
    </div>
  )
}

function HoldingsVsTarget({ s }: { s: ControlStatus }) {
  const target = s.pending ?? s.decisions.find((d) => d.status === "executed") ?? null
  const rows = useMemo(() => {
    const m = new Map<string, { cur: number; tgt: number }>()
    for (const h of s.holdings) m.set(h.market, { cur: h.weightPct, tgt: 0 })
    for (const t of target?.targets ?? []) m.set(t.market, { cur: m.get(t.market)?.cur ?? 0, tgt: t.weightPct })
    return [...m.entries()].sort((a, b) => Math.max(b[1].cur, b[1].tgt) - Math.max(a[1].cur, a[1].tgt))
  }, [s.holdings, target])
  const max = Math.max(10, ...rows.map(([, r]) => Math.max(r.cur, r.tgt)))
  if (rows.length === 0) return <EmptyState title="보유도 목표도 없음" hint="엔진이 첫 제안을 내면 여기서 현재 vs 목표 비중이 보인다." />
  return (
    <div className="space-y-1.5">
      {rows.map(([market, r]) => (
        <div key={market} className="grid grid-cols-[52px_1fr_88px] items-center gap-2 font-mono text-[11px] tnum">
          <span>{sym(market)}</span>
          <div className="relative h-4 rounded bg-muted/40">
            <div className="absolute inset-y-0 left-0 rounded bg-sky-400/70" style={{ width: `${(r.cur / max) * 100}%` }} />
            <div className="absolute inset-y-0 w-0.5 bg-amber-300" style={{ left: `${(r.tgt / max) * 100}%` }} title={`목표 ${r.tgt.toFixed(1)}%`} />
          </div>
          <span className="text-right text-muted-foreground">{r.cur.toFixed(1)}% → <span className="text-amber-300">{r.tgt.toFixed(1)}%</span></span>
        </div>
      ))}
      <p className="pt-1 text-[10px] text-muted-foreground">파란 막대 = 현재 비중 · 노란 선 = {s.pending ? "승인 대기 목표" : "마지막 집행 목표"} · 현금 {s.equityKrw > 0 ? ((s.cashKrw / s.equityKrw) * 100).toFixed(1) : "0"}% ({krw(s.cashKrw)})</p>
    </div>
  )
}

export function CommandCenter() {
  const { data, error, isLoading, mutate } = useControl()
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) toast.success(ok)
      await mutate()
    } catch (e) {
      toast.error(explain(e))
    } finally {
      setBusy(false)
    }
  }, [mutate])

  if (error && isBackendNotConfigured(error)) return <EmptyState title="백엔드 미연결" hint="BACKEND_URL / BACKEND_TOKEN 이 설정되면 제어 평면이 여기 나타난다." />
  if (error) return <EmptyState title="제어 평면 상태를 읽지 못함" hint={error instanceof Error ? error.message : String(error)} />
  if (isLoading || !data) return <Skeleton className="h-[420px]" />
  const s = data

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">command center · 통합 제어 평면</p>
            <p className="text-sm text-muted-foreground">엔진은 제안만 낸다. 알트를 포함한 유니버스 전체가 거래 대상이다. 중재기가 하나의 목표로 섞고, {s.paused ? "지금은 정지 상태라 아무것도 집행하지 않는다." : s.autopilot ? `오토파일럿이 곧바로 ${s.mode === "paper" ? "페이퍼 " : ""}장부를 회전한다. 보류된 결정은 ${s.scheduler.everyMin}분 스케줄러가 집행 간격이 지나면 사람 없이 집행한다.` : "운영자가 승인해야 장부를 회전한다."}</p>
            <p className={cn("mt-1 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold", s.paused ? "border-rose-500/70 text-rose-400" : s.unattended ? "border-emerald-400/60 text-emerald-300" : "border-amber-400/60 text-amber-300")}>
              <span className={cn("size-1.5 rounded-full", s.paused ? "bg-rose-400" : s.unattended ? "bg-emerald-400 animate-pulse" : "bg-amber-300")} aria-hidden="true" />
              {s.paused ? `정지됨 · ${s.pausedBy ?? "operator"} · ${s.pausedAt ? ago(s.pausedAt) : ""}` : s.unattended ? `사람 없이 운행 중 · 가중치 5분 자동 갱신 · 스케줄러 ${s.scheduler.lastTickAt ? ago(s.scheduler.lastTickAt) : "대기"}` : s.killSwitch ? "킬 스위치 — 집행 차단" : "승인제 — 결정마다 사람이 승인"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {s.killSwitch && <span className="rounded-full border border-rose-500/70 px-2 py-0.5 text-[11px] font-semibold text-rose-400">KILL SWITCH — 집행 차단</span>}
            {s.paused ? (
              <button type="button" disabled={busy} onClick={() => void run(() => resumeControl(), "자동 운행 재개 — 보류 결정을 다시 중재")} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50"><Play className="size-3.5" aria-hidden="true" /> 자동 운행 재개</button>
            ) : (
              <button type="button" disabled={busy} onClick={() => void run(() => pauseControl(), "정지 — 재개 전까지 어떤 결정도 집행되지 않는다 (재배포에도 유지)")} className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/70 px-3 py-1.5 text-xs font-semibold text-rose-400 disabled:opacity-50"><OctagonX className="size-3.5" aria-hidden="true" /> 자동 운행 정지</button>
            )}
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{s.mode === "paper" ? "PAPER" : s.mode.toUpperCase()}</span>
            <button type="button" disabled={busy} onClick={() => void run(() => arbitrateNow(), "중재 실행")} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs disabled:opacity-50"><Gavel className="size-3.5" aria-hidden="true" /> 지금 중재</button>
            <button type="button" disabled={busy} onClick={() => void mutate()} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs" aria-label="새로고침"><RefreshCw className="size-3.5" aria-hidden="true" /></button>
            <div className="inline-flex items-center overflow-hidden rounded-md border border-border text-xs" role="radiogroup" aria-label="집행 모드">
              <span className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">집행</span>
              <button type="button" role="radio" aria-checked={s.autopilot} disabled={busy || s.autopilot} onClick={() => void run(() => setAutopilot(true), "자동 집행 — 협의회 결정을 스케줄러가 집행한다")} className={cn("inline-flex items-center gap-1 px-2.5 py-1.5 font-semibold", s.autopilot ? "bg-emerald-500 text-black" : "text-muted-foreground hover:text-foreground")}><Play className="size-3.5" aria-hidden="true" /> 자동</button>
              <button type="button" role="radio" aria-checked={!s.autopilot} disabled={busy || !s.autopilot} onClick={() => void run(() => setAutopilot(false), "승인제 — 이번 부팅 동안 결정마다 사람이 승인 (재배포하면 자동으로 돌아감)")} className={cn("inline-flex items-center gap-1 px-2.5 py-1.5 font-semibold", !s.autopilot ? "bg-amber-400 text-black" : "text-muted-foreground hover:text-foreground")}><Pause className="size-3.5" aria-hidden="true" /> 승인</button>
            </div>
          </div>
        </div>
        <div className="mt-3">
          <SystemMap s={s} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px] tnum text-muted-foreground md:grid-cols-4 xl:grid-cols-8">
          <span>최대 비중 {s.policy.maxWeightPct}%</span>
          <span>최대 {s.policy.maxPositions}종목</span>
          <span>현금 하한 {s.policy.cashFloorPct}%</span>
          <span>총노출 ≤ {s.policy.grossMaxPct}%</span>
          <span>회전 {s.policy.minTurnoverPct}~{s.policy.maxTurnoverPct ?? "∞"}%</span>
          <span>집행 간격 ≥ {s.policy.minIntervalMin}분</span>
          <span>제안 유효 {s.policy.proposalTtlH}h</span>
          <span>마지막 집행 {s.lastExecutedAt ? ago(s.lastExecutedAt) : "없음"}</span>
        </div>
        {s.attribution && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border/70 bg-muted/20 px-3 py-2 font-mono text-[11px] tnum">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">귀속 · {s.attribution.intervalMin}분 마크</span>
            <span>결정 타율 <b className={s.attribution.decisions.hitRate !== null && s.attribution.decisions.hitRate >= 0.5 ? "text-emerald-300" : "text-rose-300"}>{s.attribution.decisions.hitRate === null ? "—" : `${(s.attribution.decisions.hitRate * 100).toFixed(0)}%`}</b> <span className="text-muted-foreground">({s.attribution.decisions.wins}/{s.attribution.decisions.closed} 마감)</span></span>
            <span>결정당 평균 <b className={(s.attribution.decisions.avgPct ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}>{s.attribution.decisions.avgPct === null ? "—" : `${s.attribution.decisions.avgPct >= 0 ? "+" : ""}${s.attribution.decisions.avgPct.toFixed(2)}%`}</b></span>
            <span>합계 {s.attribution.decisions.sumPct === null ? "—" : `${s.attribution.decisions.sumPct >= 0 ? "+" : ""}${s.attribution.decisions.sumPct.toFixed(2)}%`}</span>
            {s.attribution.decisions.open && <span className="text-muted-foreground">진행 중 {s.attribution.decisions.open.pct >= 0 ? "+" : ""}{s.attribution.decisions.open.pct.toFixed(2)}% · {s.attribution.decisions.open.marks}마크</span>}
          </div>
        )}
        {s.councilModes && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border/70 bg-muted/20 px-3 py-2 font-mono text-[11px] tnum">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">의결 방식 · 같은 제안을 두 방식으로 매 틱 채점</span>
            <div className="inline-flex overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="의결 방식">
              {s.councilModes.map((m) => (
                <button key={m.mode} type="button" role="radio" aria-checked={m.active} disabled={busy || m.active} onClick={() => void run(() => setControlPolicy({ councilMode: m.mode }), `${MODE_KO[m.mode]}로 전환 — 즉시 재중재`)} className={cn("px-2.5 py-1 font-semibold", m.active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>{MODE_KO[m.mode]}</button>
              ))}
            </div>
            {s.councilModes.map((m) => (
              <span key={m.mode} className={m.active ? "" : "text-muted-foreground"}>
                {MODE_KO[m.mode]}{m.active ? "(실집행)" : "(그림자)"} 누적 <b className={m.cumReturnPct > 0 ? "text-emerald-300" : m.cumReturnPct < 0 ? "text-rose-300" : ""}>{m.cumReturnPct >= 0 ? "+" : ""}{m.cumReturnPct.toFixed(2)}%</b> · 타율 {m.hitRate === null ? "—" : `${(m.hitRate * 100).toFixed(0)}%`}/{m.marks} · 결정 {m.decisions} · {m.targets.length}종목
              </span>
            ))}
            <span className="text-muted-foreground">비례제 문턱 {s.policy.convictionMin}</span>
          </div>
        )}
      </Card>

      {s.pending && (
        <DecisionCard d={s.pending} pending busy={busy} auto={s.autopilot && !s.paused ? { nextEligibleAt: s.scheduler.nextEligibleAt, everyMin: s.scheduler.everyMin } : null} onApprove={() => void run(() => approveDecision(), s.autopilot ? "지금 집행 — 페이퍼 장부 회전" : "승인 — 페이퍼 장부 회전")} onReject={() => void run(() => rejectDecision(), "결정 거부")} />
      )}

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="p-4 xl:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold">총괄 매니저 협의회</h2>
            <span className="text-[10px] text-muted-foreground">제안 3(오피스·진화·신호) + 감성·리스크 2 · 정족수 = 제안 매니저 2명 · 신호 혼자서는 매수 불가 · 유니버스 = 메이저 + 알트 상위 30</span>
          </div>
          <div className="space-y-2">
            {s.engines.map((e) => (
              <EngineRow key={e.id} e={e} onChange={(patch) => run(() => setEngine(e.id, patch))} />
            ))}
            {(s.managers ?? []).filter((m) => !m.proposes).map((m) => (
              <div key={m.id} className="rounded-lg border border-dashed border-border p-3">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ background: MANAGER_COLOR[m.id] }} aria-hidden="true" />
                  <span className="text-sm font-semibold">{m.nameKo}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{m.name}</span>
                  <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{m.id === "risk" ? "거부권" : "지지·반대"}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{m.description}</p>
              </div>
            ))}
          </div>
        </Card>
        <div className="flex flex-col gap-4 xl:col-span-3">
          <Card className="p-4">
            <h2 className="mb-2 text-sm font-bold">보유 vs 목표</h2>
            <HoldingsVsTarget s={s} />
          </Card>
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-bold">결정 로그</h2>
              <span className="font-mono text-[10px] text-muted-foreground">{s.decisions.length}건 · 살아있는 제안 {s.proposals.length}</span>
            </div>
            {s.decisions.length === 0 ? (
              <EmptyState title="아직 결정 없음" hint="스캐너 로테이션·오피스 합의·진화 스쿼드·파이프라인 스냅샷이 제안을 내면 중재기가 여기 기록한다." />
            ) : (
              <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
                {s.decisions.map((d) => <DecisionCard key={d.id} d={d} />)}
              </div>
            )}
          </Card>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">기본은 무인 운행이다 — 아무것도 누르지 않아도 협의회가 결정하고 스케줄러가 페이퍼 집행한다. 조작(정지·모드·참여·가중)만 <Link href="/login" className="underline">로그인</Link> 세션이 필요하고, 페이퍼 외 실거래는 이 화면에서 켤 수 없다.</p>
    </div>
  )
}
