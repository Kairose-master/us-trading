"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { cn } from "@/lib/utils"
import { ApiError, breakSource, getPipelineNode, getSupervisor, getSupervisorLogs, supervisorAction, supervisorAutoRecovery, type Market, type OpsLogLine, type SupervisorSnapshot } from "@/lib/api"
import { toast } from "sonner"
import { useLiveChannel, useLiveStatus } from "@/hooks/useLiveSocket"
import type { PipelineLogLine, PipelineSnapshot, PipelineStage } from "@/lib/types"
import { MonitorGraph, STAGE_LABEL, STAGE_TAG, STATUS_COLOR, STATUS_LABEL, fmtRate, resetCameraHint } from "./monitor-graph"

/**
 * 파이프라인 모니터 — 상단 스트림 상태 · 좌측 스테이지/노드 목록 · 중앙 그래프 ·
 * 우측 선택 노드 상세(실측 지표·설명·입출력·라이브 샘플 행) · 하단 로그.
 * 숫자는 전부 백엔드 계측값이고, 흐르는 빛은 실제 처리 증가분에서만 나온다.
 */

const STAGES: PipelineStage[] = ["ingestion", "features", "models", "strategy", "execution"]
const t = (s: string) => new Date(s).toLocaleTimeString("ko-KR", { hour12: false })

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-[#5b6b5b]">{children}</p>
}
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-[#1c221c] bg-[#0b0e0b] px-2.5 py-2">
      <Label>{label}</Label>
      <p className="mt-0.5 font-mono text-[15px] font-semibold text-[#e5efe5]">{value}</p>
      {sub && <p className="font-mono text-[9px] text-[#5b6b5b]">{sub}</p>}
    </div>
  )
}

function logTone(msg: string) {
  if (/차단|blocked|error|오류|실패|failed/i.test(msg)) return "text-[#f87171]"
  if (/retry|재시도|backoff|대기|hold/i.test(msg)) return "text-[#fbbf24]"
  if (/신호|signal|buy|sell|매수|매도|통과/i.test(msg)) return "text-[#bef264]"
  return "text-[#9fb09f]"
}

export function PipelineMonitor({ snapshot, logs, market, onMarket, selected, onSelect }: { snapshot: PipelineSnapshot; logs: PipelineLogLine[]; market: Market; onMarket: (m: Market) => void; selected: string | null; onSelect: (id: string | null) => void }) {
  const ws = useLiveStatus()
  const [mode, setMode] = useState<"3d" | "flat">("3d")
  // ===== 수집 감독자 (self-healing) — 실측 상태 + 오케스트레이터 로그 =====
  const { data: supFetched, mutate: mutateSup } = useSWR(["supervisor", market], () => getSupervisor(market), { refreshInterval: 4000 })
  const { data: opsFetched } = useSWR(["supervisor-logs", market], () => getSupervisorLogs(80, market), { refreshInterval: 4000 })
  const [supLive, setSupLive] = useState<SupervisorSnapshot | null>(null)
  const [opsLive, setOpsLive] = useState<OpsLogLine[]>([])
  useLiveChannel(["ops", "ops:log"], (raw) => {
    const msg = raw as unknown as { ch: string; data: unknown }
    if (msg.ch === "ops") setSupLive(msg.data as SupervisorSnapshot)
    if (msg.ch === "ops:log") setOpsLive((prev) => [msg.data as OpsLogLine, ...prev].slice(0, 80))
  })
  const sup = supLive ?? supFetched ?? null
  const supSources = (sup?.sources ?? []).filter((x) => x.market === market || x.market === "all")
  const opsLogs = dedupeOps([...opsLive, ...(opsFetched ?? [])]).filter((l) => l.source === "supervisor" || supSources.some((x) => x.id === l.source)).slice(0, 60)
  const [breakSec, setBreakSec] = useState(30)
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true)
    try {
      await fn()
      toast.success(label)
      mutateSup()
    } catch (e) {
      const err = e as ApiError
      toast.error(err.status === 401 || err.code === "NO_SESSION" ? "로그인(owner)이 필요합니다 — 설정 · 키에서 로그인" : err.message)
    } finally {
      setBusy(false)
    }
  }
  const sourceForNode = (nodeId: string) => supSources.find((x) => x.feedsNode === nodeId) ?? null
  const selSource = selected ? sourceForNode(selected) : null
  const [resetKey, setResetKey] = useState(0)
  const { data: detail } = useSWR(selected ? ["pipeline-node", market, selected] : null, () => getPipelineNode(selected!, market), { refreshInterval: 2000 })
  const [flashRow, setFlashRow] = useState<string | null>(null)
  useEffect(() => {
    const first = detail?.sample.rows[0]?.join("|") ?? null
    if (first && first !== flashRow) setFlashRow(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail])

  const nodes = snapshot.nodes
  const errors = nodes.filter((n) => n.metrics.status === "error").length
  const throughput = nodes.filter((n) => n.stage === "ingestion").reduce((a, n) => a + n.metrics.throughputPerSec, 0)
  const byStage = useMemo(() => new Map(STAGES.map((s) => [s, nodes.filter((n) => n.stage === s)])), [nodes])
  const sel = selected ? nodes.find((n) => n.id === selected) ?? null : null
  const readsFrom = sel ? snapshot.edges.filter((e) => e.to === sel.id).map((e) => e.from) : []
  const feeds = sel ? snapshot.edges.filter((e) => e.from === sel.id).map((e) => e.to) : []

  return (
    <div className="overflow-hidden rounded-lg border border-[#1c221c] bg-[#070907] font-mono text-[#c7d2c7]">
      {/* 상단 바 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#1c221c] px-3 py-2 text-[10px]">
        <span className="font-semibold tracking-wide text-[#e5efe5]">US·CRYPTO / DATA PLATFORM</span>
        <div className="flex gap-3">
          {(["crypto", "us"] as Market[]).map((m) => (
            <button key={m} type="button" onClick={() => onMarket(m)} className={cn("uppercase tracking-[0.14em]", market === m ? "border-b border-[#a3e635] text-[#a3e635]" : "text-[#5b6b5b] hover:text-[#9fb09f]")}>
              {m === "crypto" ? "crypto · upbit" : "us · yahoo"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3 uppercase tracking-[0.12em] text-[#7c8c7c]">
          <span className="flex items-center gap-1"><i className={cn("inline-block size-1.5 rounded-full", ws === "connected" ? "bg-[#a3e635] shadow-[0_0_6px_#a3e635]" : "bg-[#6b7280]")} />stream {ws === "connected" ? "live" : "poll"}</span>
          <span>nodes <b className="text-[#e5efe5]">{snapshot.nodesActive}/{snapshot.nodesTotal}</b> active</span>
          {sup && <span>sources <b className={sup.failing ? "text-[#f87171]" : "text-[#e5efe5]"}>{supSources.filter((x) => x.status === "healthy").length}/{supSources.length}</b> healthy{sup.paused ? " · PAUSED" : ""}</span>}
          <span>failing <b className={errors ? "text-[#f87171]" : "text-[#e5efe5]"}>{errors}</b></span>
          <span>latency <b className="text-[#e5efe5]">{snapshot.latencyMs.toFixed(2)}ms</b></span>
          <span>throughput <b className="text-[#e5efe5]">{fmtRate(throughput)}</b></span>
          <span>alpha stability <b className="text-[#e5efe5]">{snapshot.alphaStability.toFixed(3)}</b></span>
        </div>
      </div>

      <div className="grid lg:grid-cols-[190px_1fr_300px]">
        {/* 좌측 */}
        <aside className="hidden max-h-[760px] overflow-y-auto border-r border-[#1c221c] p-3 lg:block">
          <Label>run control</Label>
          <div className="mt-1.5 grid grid-cols-3 gap-1">
            <button type="button" disabled={busy || !sup} onClick={() => act(() => supervisorAction(sup?.paused ? "resume" : "pause"), sup?.paused ? "재개" : "일시정지")} className="rounded border border-[#2a332a] bg-[#0b0e0b] px-1 py-1.5 text-[9px] uppercase tracking-[0.12em] text-[#b7c4b7] hover:border-[#a3e635] disabled:opacity-50">{sup?.paused ? "resume" : "pause"}</button>
            <button type="button" disabled={busy || !selSource} title={selSource ? `${selSource.id}에 ${breakSec}s 장애 주입` : "그래프에서 소스 노드(tick-data / news-stream)를 선택"} onClick={() => selSource && act(() => breakSource(selSource.id, breakSec), `${selSource.id} 장애 주입 ${breakSec}s`)} className="rounded border border-[#2a332a] bg-[#0b0e0b] px-1 py-1.5 text-[9px] uppercase tracking-[0.12em] text-[#fbbf24] hover:border-[#fbbf24] disabled:opacity-40">break node</button>
            <button type="button" disabled={busy || !sup} onClick={() => act(() => supervisorAction("heal"), "HEAL ALL")} className="rounded border border-[#2a332a] bg-[#0b0e0b] px-1 py-1.5 text-[9px] uppercase tracking-[0.12em] text-[#a3e635] hover:border-[#a3e635] disabled:opacity-50">heal all</button>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[9px] text-[#7c8c7c]">
            <span>break for</span>
            <input type="range" min={5} max={180} step={5} value={breakSec} onChange={(e) => setBreakSec(Number(e.target.value))} className="h-1 flex-1 accent-[#a3e635]" aria-label="장애 주입 시간(초)" />
            <span className="w-8 text-right text-[#b7c4b7]">{breakSec}s</span>
          </div>
          <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[9.5px] text-[#9fb09f]">
            <input type="checkbox" checked={sup?.autoRecovery ?? true} disabled={busy || !sup} onChange={(e) => act(() => supervisorAutoRecovery(e.target.checked), e.target.checked ? "auto-recovery ON" : "auto-recovery OFF")} className="accent-[#a3e635]" />
            auto-recovery (retry + backfill)
          </label>
          <p className="mt-1 text-[8.5px] leading-snug text-[#4b5a4b]">break는 진짜 장애 주입이다 — 그 소스의 수집이 실제로 실패하고, 감독자가 실제로 재시도·회복·백필한다. 조작은 owner 로그인 필요.</p>

          <div className="mt-4"><Label>sources · self-healing</Label></div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {supSources.length === 0 && <li className="text-[9.5px] text-[#4b5a4b]">no sources registered</li>}
            {supSources.map((x) => (
              <li key={x.id} className="rounded border border-[#1c221c] bg-[#0b0e0b] px-2 py-1.5 text-[9.5px]">
                <div className="flex items-center gap-1.5">
                  <i className={cn("inline-block size-1.5 rounded-full", x.status === "healthy" ? "bg-[#a3e635]" : x.status === "degraded" ? "bg-[#fbbf24] animate-pulse" : x.status === "paused" ? "bg-[#6b7280]" : "bg-[#ef4444] animate-pulse")} />
                  <span className="truncate font-semibold text-[#c7d2c7]">{x.id}</span>
                  <span className="ml-auto uppercase" style={{ color: x.status === "healthy" ? "#a3e635" : x.status === "degraded" ? "#fbbf24" : x.status === "paused" ? "#6b7280" : "#ef4444" }}>{x.status}</span>
                </div>
                <div className="mt-0.5 flex justify-between text-[#7c8c7c]">
                  <span>{x.rowsPerSec.toFixed(1)}/s · lag {(x.lagMs / 1000).toFixed(1)}s{x.lagMs > x.slaMs ? " ⚠ sla" : ""}</span>
                  <span>{x.consecutiveFailures > 0 ? `retry ${x.attempt} · ${(x.backoffMs / 1000).toFixed(1)}s` : `${x.recoveries} rec · ${x.failures} fail`}</span>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-4"><Label>pipeline health</Label></div>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <Tile label="active" value={`${snapshot.nodesActive}/${snapshot.nodesTotal}`} />
            <Tile label="failing" value={String(errors)} />
            <Tile label="msg/s" value={fmtRate(throughput).replace("/s", "")} />
            <Tile label="latency" value={`${snapshot.latencyMs.toFixed(1)}ms`} />
          </div>
          <div className="mt-4"><Label>stages</Label></div>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {STAGES.map((s, i) => (
              <li key={s} className="flex items-center gap-2 rounded px-1.5 py-1 text-[10px] text-[#b7c4b7]">
                <i className="inline-block size-1.5 rounded-full" style={{ background: byStage.get(s)!.some((n) => n.metrics.status === "error") ? "#ef4444" : byStage.get(s)!.some((n) => n.metrics.status === "active") ? "#a3e635" : "#4b5563" }} />
                <span className="text-[#5b6b5b]">0{i + 1}</span>
                <span className="font-semibold tracking-wide">{STAGE_LABEL[s]}</span>
                <span className="ml-auto text-[#5b6b5b]">{byStage.get(s)!.length}</span>
              </li>
            ))}
          </ul>
          {STAGES.map((s, i) => (
            <div key={s} className="mt-3">
              <Label>0{i + 1} · {STAGE_LABEL[s]}</Label>
              <ul className="mt-1 flex flex-col">
                {byStage.get(s)!.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => onSelect(n.id === selected ? null : n.id)} className={cn("flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[10px] hover:bg-[#0f140f]", selected === n.id && "bg-[#0f160f]")}>
                      <i className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[n.metrics.status] }} />
                      <span className="truncate text-[#c7d2c7]">{n.id}</span>
                      <span className="ml-auto shrink-0 text-[#5b6b5b]">{n.metrics.status === "active" ? fmtRate(n.metrics.throughputPerSec) : STATUS_LABEL[n.metrics.status]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>

        {/* 중앙 */}
        <div className="relative min-w-0">
          <div className="absolute left-3 top-3 z-10 flex overflow-hidden rounded border border-[#1c221c] bg-[#0b0e0b] text-[9px] uppercase tracking-[0.14em]">
            {(["3d", "flat"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={cn("px-2.5 py-1", mode === m ? "bg-[#152015] text-[#a3e635]" : "text-[#5b6b5b] hover:text-[#9fb09f]")}>{m}</button>
            ))}
            <button type="button" onClick={() => setResetKey((k) => k + 1)} className="border-l border-[#1c221c] px-2.5 py-1 text-[#5b6b5b] hover:text-[#9fb09f]">reset view</button>
          </div>
          <MonitorGraph snapshot={snapshot} selected={selected} onSelect={onSelect} mode={mode} resetKey={resetKey} height={480} sourceStatus={Object.fromEntries(supSources.map((x) => [x.feedsNode, x.status]))} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#1c221c] px-3 py-1.5 text-[9px] uppercase tracking-[0.1em] text-[#5b6b5b]">
            {STAGES.map((s) => (
              <span key={s}><b className="mr-1 rounded border border-[#2a332a] px-1 py-px text-[#9fb09f]">{STAGE_TAG[s]}</b>{STAGE_LABEL[s].toLowerCase()}</span>
            ))}
            <span className="ml-auto flex items-center gap-3">
              <span><i className="mr-1 inline-block size-1.5 rounded-full bg-[#a3e635]" />running</span>
              <span><i className="mr-1 inline-block size-1.5 rounded-full bg-[#6b7280]" />idle</span>
              <span><i className="mr-1 inline-block size-1.5 rounded-full bg-[#ef4444]" />failed</span>
            </span>
          </div>
          <p className="border-t border-[#1c221c] px-3 py-1 text-[9px] text-[#4b5a4b]">{resetCameraHint()} · click a node for its detail and live rows</p>

          {/* 오케스트레이터 로그 — 감독자의 실제 결정 */}
          <div className="border-t border-[#1c221c]">
            <div className="flex items-center justify-between px-3 py-1.5">
              <Label>orchestrator log</Label>
              <span className="text-[9px] text-[#4b5a4b]">failures retry with exponential backoff, then backfill — newest first</span>
            </div>
            <ul className="max-h-36 overflow-y-auto px-3 pb-2 text-[10px] leading-relaxed">
              {opsLogs.length === 0 && <li className="text-[#4b5a4b]">no orchestrator events yet</li>}
              {opsLogs.map((l, i) => (
                <li key={`${l.ts}-${i}`} className="flex gap-3">
                  <span className="shrink-0 text-[#4b5a4b]">{t(l.ts)}</span>
                  <span className="w-28 shrink-0 truncate text-[#7c8c7c]">{l.source}</span>
                  <span className={cn("truncate", l.level === "error" ? "text-[#f87171]" : l.level === "warn" ? "text-[#fbbf24]" : l.level === "ok" ? "text-[#bef264]" : "text-[#9fb09f]")}>{l.message}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* 하단 로그 */}
          <div className="border-t border-[#1c221c]">
            <div className="flex items-center justify-between px-3 py-1.5">
              <Label>pipeline log</Label>
              <span className="text-[9px] text-[#4b5a4b]">signals · risk blocks · sentiment — newest first</span>
            </div>
            <ul className="max-h-40 overflow-y-auto px-3 pb-2 text-[10px] leading-relaxed">
              {logs.length === 0 && <li className="text-[#4b5a4b]">no log lines yet — nothing has flowed</li>}
              {logs.slice(0, 40).map((l, i) => (
                <li key={`${l.ts}-${i}`} className="flex gap-3">
                  <span className="shrink-0 text-[#4b5a4b]">{t(l.ts)}</span>
                  <span className="w-28 shrink-0 truncate text-[#7c8c7c]">{l.node}</span>
                  <span className={cn("truncate", logTone(l.message))}>{l.message}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* 우측 상세 */}
        <aside className="max-h-[720px] overflow-y-auto border-t border-[#1c221c] p-3 lg:border-l lg:border-t-0">
          {!sel ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-center text-[10px] text-[#4b5a4b]">
              <p>click a node</p>
              <p>metrics · description · reads-from / feeds · live sample rows</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded border border-[#2a332a] px-1 py-px text-[9px] text-[#a3e635]">{STAGE_TAG[sel.stage]}</span>
                  <span className="text-[13px] font-bold text-[#e5efe5]">{sel.id}</span>
                </div>
                <p className="mt-0.5 text-[10px] text-[#7c8c7c]">{sel.name} · {STAGE_LABEL[sel.stage].toLowerCase()}{sel.metrics.lastRunAt ? ` · last run ${t(sel.metrics.lastRunAt)}` : " · never ran"}</p>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <Tile label="msg/s" value={fmtRate(sel.metrics.throughputPerSec).replace("/s", "")} sub="last 10s" />
                <Tile label="msgs seen" value={sel.metrics.totalMsgs >= 1000 ? `${(sel.metrics.totalMsgs / 1000).toFixed(1)}k` : String(sel.metrics.totalMsgs)} sub="since boot" />
                <Tile label="latency" value={`${sel.metrics.avgLatencyMs.toFixed(2)}ms`} sub={`last ${sel.metrics.lastLatencyMs.toFixed(2)}ms`} />
              </div>
              {selSource && (
                <div className="rounded border border-[#1c221c] bg-[#0b0e0b] p-2">
                  <div className="flex items-center justify-between"><Label>source · {selSource.id}</Label><span className="text-[9px] uppercase" style={{ color: selSource.status === "healthy" ? "#a3e635" : selSource.status === "degraded" ? "#fbbf24" : "#ef4444" }}>{selSource.status}</span></div>
                  <p className="mt-1 text-[9.5px] text-[#9fb09f]">{selSource.name} · every {(selSource.intervalMs / 1000).toFixed(0)}s · sla {(selSource.slaMs / 1000).toFixed(0)}s · {selSource.replayable ? "replayable (backfill)" : "not replayable"}</p>
                  <p className="text-[9.5px] text-[#7c8c7c]">lag {(selSource.lagMs / 1000).toFixed(1)}s · {selSource.rowsTotal.toLocaleString()} rows · {selSource.recoveries} recoveries · {selSource.failures} failures{selSource.consecutiveFailures > 0 ? ` · retry ${selSource.attempt} in ${(selSource.backoffMs / 1000).toFixed(1)}s` : ""}</p>
                  {selSource.lastError && <p className="mt-0.5 text-[9.5px] text-[#f87171]">{selSource.lastError}</p>}
                </div>
              )}
              <div>
                <Label>state</Label>
                <p className="text-[13px] font-bold" style={{ color: STATUS_COLOR[sel.metrics.status] }}>{STATUS_LABEL[sel.metrics.status]}</p>
                {sel.metrics.lastError && <p className="text-[10px] text-[#f87171]">{sel.metrics.lastError}</p>}
              </div>
              <p className="border-y border-[#1c221c] py-2 text-[10px] leading-relaxed text-[#9fb09f]">{sel.description}</p>
              <pre className="overflow-x-auto rounded border border-[#1c221c] bg-[#0b0e0b] p-2 text-[9.5px] leading-relaxed text-[#8fa38f]">{sel.codeHint}</pre>
              <div>
                <Label>reads from</Label>
                <div className="mt-1 flex flex-wrap gap-1">{readsFrom.length ? readsFrom.map((r) => <button key={r} type="button" onClick={() => onSelect(r)} className="rounded border border-[#2a332a] bg-[#0b0e0b] px-1.5 py-px text-[9.5px] text-[#b7c4b7] hover:border-[#a3e635]">{r}</button>) : <span className="text-[9.5px] text-[#4b5a4b]">external source — nothing upstream</span>}</div>
              </div>
              <div>
                <Label>feeds</Label>
                <div className="mt-1 flex flex-wrap gap-1">{feeds.length ? feeds.map((r) => <button key={r} type="button" onClick={() => onSelect(r)} className="rounded border border-[#2a332a] bg-[#0b0e0b] px-1.5 py-px text-[9.5px] text-[#b7c4b7] hover:border-[#a3e635]">{r}</button>) : <span className="text-[9.5px] text-[#4b5a4b]">terminal — the desk reads this</span>}</div>
              </div>
              <div>
                <div className="flex items-center justify-between"><Label>sample rows — live</Label><span className="text-[9px] text-[#4b5a4b]">{detail?.sample.columns.length ?? 0} cols</span></div>
                {!detail ? (
                  <p className="mt-1 text-[10px] text-[#4b5a4b]">loading…</p>
                ) : detail.sample.rows.length === 0 ? (
                  <p className="mt-1 text-[10px] text-[#4b5a4b]">no rows yet — this node has not emitted</p>
                ) : (
                  <div className="mt-1 overflow-x-auto">
                    <table className="w-full text-[9.5px]">
                      <thead><tr className="text-left text-[#5b6b5b]">{detail.sample.columns.map((c) => <th key={c} className="pr-2 font-medium uppercase tracking-wider">{c}</th>)}</tr></thead>
                      <tbody>
                        {detail.sample.rows.map((r, i) => {
                          const key = r.join("|")
                          return (
                            <tr key={`${key}-${i}`} className={cn("border-t border-[#141914]", i === 0 && key === flashRow ? "bg-[#1a2a12] text-[#d9f99d]" : "text-[#b7c4b7]")}>
                              {r.map((c, j) => <td key={j} className="whitespace-nowrap pr-2 py-0.5">{typeof c === "number" ? (Number.isInteger(c) ? c : c.toFixed(4)) : c}</td>)}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="mt-1 text-[9px] text-[#4b5a4b]">newest first · refreshed every 2s from the node&apos;s last output</p>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function dedupeOps(lines: OpsLogLine[]): OpsLogLine[] {
  const seen = new Set<string>()
  return lines.filter((l) => {
    const k = `${l.ts}|${l.source}|${l.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
