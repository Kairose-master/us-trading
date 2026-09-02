"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Dna } from "lucide-react"
import { ApiError, evoDeploy, evoStep, getEvoAgents, getEvoLineage, getEvoLog, getEvolution, isBackendNotConfigured, type EvoAgent, type EvoLog } from "@/lib/api"
import { useLiveChannel } from "@/hooks/useLiveSocket"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { GenerationCurves, PopulationCloud, fitnessColor } from "@/components/evolution/population-cloud"
import { cn } from "@/lib/utils"

const krw = (v: number) => `₩${Math.round(v).toLocaleString("ko-KR")}`
const t = (s: string) => new Date(s).toLocaleTimeString("ko-KR", { hour12: false })

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[9px] font-medium uppercase tracking-[0.16em] text-[#8a4b4b]">{children}</p>
}
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-[#3a1a1e] bg-[#0f0a0c] px-2.5 py-2">
      <Label>{label}</Label>
      <p className="mt-0.5 font-mono text-[15px] font-semibold text-[#fecaca]">{value}</p>
      {sub && <p className="font-mono text-[9px] text-[#8a4b4b]">{sub}</p>}
    </div>
  )
}

/** NEURAL CORE — 세대 링 게이지 (릴의 중앙 원) */
function CoreRing({ gen, alive, popMax, running }: { gen: number; alive: number; popMax: number; running: boolean }) {
  const frac = popMax ? alive / popMax : 0
  const R = 78, C = 2 * Math.PI * R
  return (
    <div className="relative mx-auto flex size-[200px] items-center justify-center">
      <svg viewBox="0 0 200 200" className="absolute inset-0 size-full -rotate-90">
        <circle cx="100" cy="100" r={R + 12} fill="none" stroke="#2a1216" strokeWidth="1" />
        <circle cx="100" cy="100" r={R} fill="none" stroke="#3a1a1e" strokeWidth="6" />
        <circle cx="100" cy="100" r={R} fill="none" stroke="#ef4444" strokeWidth="6" strokeDasharray={`${C * frac} ${C}`} strokeLinecap="round" className={cn(running && "animate-pulse")} style={{ filter: "drop-shadow(0 0 6px #ef4444aa)" }} />
      </svg>
      <div className="text-center font-mono">
        <p className="text-[9px] uppercase tracking-[0.2em] text-[#8a4b4b]">generation</p>
        <p className="text-[44px] font-bold leading-none text-[#fecaca]" style={{ textShadow: "0 0 18px #ef444488" }}>{gen}</p>
        <p className="mt-1 text-[10px] text-[#c98a8a]">survivors {alive}/{popMax}</p>
        <p className="text-[9px] uppercase tracking-[0.18em] text-[#ef4444]">{running ? "engine running" : "engine online"}</p>
      </div>
    </div>
  )
}

export function EvolutionPageClient() {
  const [selected, setSelected] = useState<string | null>(null)
  const { data: status, error, mutate: mutStatus } = useSWR("evolution", getEvolution, { refreshInterval: 10_000 })
  const { data: agents, mutate: mutAgents } = useSWR("evo-agents", getEvoAgents, { refreshInterval: 10_000 })
  const { data: logFetched, mutate: mutLog } = useSWR("evo-log", () => getEvoLog(80), { refreshInterval: 10_000 })
  const { data: lineage } = useSWR("evo-lineage", getEvoLineage, { refreshInterval: 120_000, shouldRetryOnError: false })
  const [liveLog, setLiveLog] = useState<EvoLog[]>([])
  useLiveChannel(["evolution", "evolution:log"], (raw) => {
    const msg = raw as unknown as { ch: string; data: unknown }
    if (msg.ch === "evolution:log") setLiveLog((p) => [msg.data as EvoLog, ...p].slice(0, 80))
    if (msg.ch === "evolution") { mutStatus(); mutAgents() }
  })
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true)
    try { await fn(); toast.success(label); mutStatus(); mutAgents(); mutLog() } catch (e) { const err = e as ApiError; toast.error(err.status === 401 || err.code === "NO_SESSION" ? "로그인(owner)이 필요합니다 — 설정 · 키" : err.message) } finally { setBusy(false) }
  }
  const logs = useMemo(() => { const seen = new Set<string>(); return [...liveLog, ...(logFetched ?? [])].filter((l) => { const k = `${l.ts}|${l.message}`; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 60) }, [liveLog, logFetched])
  const sel: EvoAgent | null = useMemo(() => agents?.find((a) => a.id === selected) ?? null, [agents, selected])
  useEffect(() => { if (!selected && status?.champion) setSelected(status.champion.id) }, [status, selected])

  if (isBackendNotConfigured(error)) return <Card className="p-4"><EmptyState title="백엔드 미연결" hint="Vercel 환경변수 BACKEND_TOKEN이 있어야 개체군이 보입니다." /></Card>
  if (error instanceof ApiError) return <Card className="p-4 text-xs text-destructive">불러오기 실패: {error.message}</Card>
  if (!status || !agents) return <Skeleton className="h-[700px] w-full" />

  const alive = agents.filter((a) => a.alive)
  const last = status.history[status.history.length - 1]
  const deaths = agents.filter((a) => !a.alive).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Dna className="size-4 text-[#ef4444]" aria-hidden="true" />
          <h1 className="text-lg font-bold">진화 캠페인 — 서로 투자하고, 이기면 복제되고, 지면 죽는다</h1>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">PyGAD · 시험지 = 본 적 없는 {status.examDays}일 실캔들 · 페이퍼 자본 · {status.enabled ? `${status.intervalHours}h마다 세대` : "자동 세대 OFF"}</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-[#3a1a1e] bg-[#08060a] font-mono text-[#e7c9c9]">
        {/* 상단 바 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#3a1a1e] px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-[#8a4b4b]">
          <span className="font-semibold tracking-wide text-[#fecaca]">EVOLUTION CAMPAIGN</span>
          <span>running: <b className="text-[#fecaca]">upbit KRW · 27-market universe</b></span>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" disabled={busy || status.running} onClick={() => act(() => evoStep(), "세대 1회 실행")} className="rounded border border-[#7f1d1d] bg-[#1a0a0c] px-2.5 py-1 text-[9px] text-[#fecaca] hover:bg-[#2a0f12] disabled:opacity-50">▶ step generation</button>
            <button type="button" disabled={busy || status.squad.targets.length === 0} onClick={() => act(() => evoDeploy(), "스쿼드 배치 (페이퍼)")} className="rounded border border-[#7f1d1d] bg-[#7f1d1d] px-2.5 py-1 text-[9px] font-semibold text-white hover:bg-[#991b1b] disabled:opacity-50">deploy squad → paper</button>
            <span className="flex items-center gap-1"><i className="inline-block size-1.5 rounded-full bg-[#ef4444] shadow-[0_0_6px_#ef4444]" />engine {status.running ? "running" : "online"}</span>
          </div>
        </div>

        <div className="grid lg:grid-cols-[300px_1fr_320px]">
          {/* 좌: 코어 + 스탯 */}
          <div className="flex flex-col gap-3 border-b border-[#3a1a1e] p-3 lg:border-b-0 lg:border-r">
            <Label>neural core</Label>
            <CoreRing gen={status.generation} alive={status.alive} popMax={status.popMax} running={status.running} />
            <div className="grid grid-cols-2 gap-1.5">
              <Tile label="survivors" value={`${status.alive}/${status.popMax}`} sub={`${deaths} retired`} />
              <Tile label="top fitness" value={last ? last.topFitness.toFixed(2) : "—"} sub={status.champion ? status.champion.name : "no champion"} />
              <Tile label="mean fitness" value={last ? last.meanFitness.toFixed(2) : "—"} sub="sharpe − 2·mdd" />
              <Tile label="capital" value={krw(status.totalCapitalKrw)} sub={`vault ${krw(status.vaultKrw)}`} />
              <Tile label="last gen" value={status.lastGenerationAt ? t(status.lastGenerationAt) : "—"} sub={last ? last.engine : ""} />
              <Tile label="diversity" value={status.diversity.toFixed(3)} sub={`mutation rate ↑ below ${status.rules.diversityFloor}`} />
              <Tile label="mutations" value={String(status.history.reduce((a, g) => a + (g.mutations ?? 0), 0))} sub={last ? `${last.mutations ?? 0} this gen` : ""} />
              <Tile label="merges · forks" value={`${status.history.reduce((a, g) => a + (g.merges ?? 0), 0)} · ${status.history.reduce((a, g) => a + (g.forks ?? 0), 0)}`} sub={last ? `${last.merges ?? 0} · ${last.forks ?? 0} this gen` : ""} />
            </div>
            <div>
              <Label>tribes · archetypes</Label>
              <ul className="mt-1 flex flex-col gap-0.5 text-[10px]">
                {status.archetypes.filter((a) => a.alive > 0).map((a) => (
                  <li key={a.archetype} className="flex justify-between"><span className="text-[#c98a8a]">{a.archetype}</span><span className="text-[#fecaca]">{a.alive}</span></li>
                ))}
              </ul>
            </div>
            <div>
              <Label>tribes · lineages</Label>
              <ul className="mt-1 flex flex-col gap-0.5 text-[10px]">
                {status.tribes.slice().sort((a, b) => b.capitalKrw - a.capitalKrw).slice(0, 8).map((tr) => (
                  <li key={tr.tribe} className="flex justify-between"><span className="truncate text-[#c98a8a]">{tr.name}{tr.tribe.includes("/") ? "" : " lineage"}</span><span className="text-[#fecaca]">{tr.alive} · {krw(tr.capitalKrw)}</span></li>
                ))}
              </ul>
            </div>
            <div>
              <Label>desks · real MCP tools agents rent (rent paid so far {krw(status.rentPaidKrw ?? 0)})</Label>
              <ul className="mt-1 mb-2 grid grid-cols-2 gap-x-3 text-[9.5px]">
                {(status.desks ?? []).map((d) => (
                  <li key={d.id} className="flex justify-between gap-2" title={`${d.tool} @ ${d.server} — ${d.skill}`}><span className="text-[#c98a8a]">{d.labelKo}</span><span className="text-[#fecaca]">{d.tenants} tenants · {(d.rentPct * 100).toFixed(2)}%/gen</span></li>
                ))}
              </ul>
              <Label>rules</Label>
              <p className="mt-1 text-[9.5px] leading-relaxed text-[#8a4b4b]">starve &lt; {status.rules.starveRatio * 100}% of seed · bottom {status.rules.bottomQuantile * 100}% for {status.rules.bottomStreakDeath} gens → retire · child gets {status.rules.childShare * 100}% of parent capital · mutation {status.rules.mutationBase * 100}%/gen (+ when diversity &lt; {status.rules.diversityFloor}) · merge when genome distance &lt; {status.rules.mergeDistance} or delegating ≥{status.rules.mergeDependence * 100}% to a far fitter peer · fork: elite splits capital 50/50 and pushes one gene both ways · seed {krw(status.seedKrw)}</p>
            </div>
          </div>

          {/* 중: 구름 + 세대 곡선 */}
          <div className="min-w-0">
            <div className="flex items-center justify-between px-3 py-1.5"><Label>map · population cloud</Label><span className="text-[9px] text-[#8a4b4b]">dot = agent · color = fitness · size = capital · lines = peer allocations · grey = retired</span></div>
            <PopulationCloud agents={agents} selected={selected} onSelect={setSelected} height={440} />
            <div className="border-t border-[#3a1a1e]">
              <div className="flex items-center justify-between px-3 py-1.5"><Label>campaign generations · live · all survivors</Label><span className="text-[9px] text-[#8a4b4b]">fitness per agent per generation</span></div>
              <GenerationCurves agents={agents} history={status.history} height={170} />
            </div>
          </div>

          {/* 우: 개체 상세 + 스쿼드 */}
          <div className="flex flex-col gap-3 border-t border-[#3a1a1e] p-3 lg:border-l lg:border-t-0">
            {!sel ? (
              <div className="py-8 text-center text-[10px] text-[#8a4b4b]">click a dot</div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <i className="inline-block size-2.5 rounded-full" style={{ background: fitnessColor(sel.exam?.fitness ?? null, sel.alive) }} />
                  <span className="text-[13px] font-bold text-[#fecaca]">{sel.name}</span>
                  <span className="rounded border border-[#3a1a1e] px-1 py-px text-[9px] text-[#c98a8a]">{sel.archetype}</span>
                  <span className={cn("ml-auto text-[9px] uppercase", sel.alive ? "text-[#86efac]" : "text-[#6b7280]")}>{sel.alive ? "alive" : "retired"}</span>
                </div>
                <p className="text-[9.5px] text-[#8a4b4b]">gen {sel.generationBorn} · {sel.parents.length ? `child of ${agents.find((a) => a.id === sel.parents[0])?.name ?? sel.parents[0]}` : "genesis"} · {sel.children} children{sel.causeOfDeath ? ` · ${sel.causeOfDeath}` : ""}</p>
                <div className="grid grid-cols-3 gap-1.5">
                  <Tile label="fitness" value={sel.exam ? sel.exam.fitness.toFixed(2) : "—"} sub="exam (unseen)" />
                  <Tile label="return" value={sel.exam ? `${sel.exam.totalReturnPct}%` : "—"} sub={`dd ${sel.exam?.maxDrawdownPct ?? "-"}%`} />
                  <Tile label="capital" value={krw(sel.capitalKrw)} sub={`seed ${krw(sel.seedKrw)}`} />
                </div>
                <div>
                  <Label>genome</Label>
                  <ul className="mt-1 grid grid-cols-2 gap-x-3 text-[9.5px]">
                    {status.genes.map((g) => (
                      <li key={g.key} className="flex justify-between"><span className="text-[#8a4b4b]">{g.label}</span><span className="text-[#fecaca]">{sel.genes[g.key]}</span></li>
                    ))}
                  </ul>
                </div>
                <div>
                  <Label>office · desks {sel.office ? `· rent ${krw(sel.office.rentKrw)} / gen · paid ${krw(sel.rentPaidKrw ?? 0)} total` : ""}</Label>
                  {sel.office ? (
                    <div className="mt-1 flex flex-col gap-1 text-[9.5px]">
                      <div className="flex flex-wrap gap-1">
                        {sel.office.desks.map((d) => (
                          <span key={d} className="rounded border border-[#5b2a2f] bg-[#1a0d10] px-1 py-px text-[#fca5a5]">{(status.desks.find((x) => x.id === d)?.labelKo ?? d).replace(" 데스크", "")}</span>
                        ))}
                        {sel.office.usesOffice && <span className="rounded border border-[#5b2a2f] bg-[#1a0d10] px-1 py-px text-[#fde68a]">위원회 결정</span>}
                        <span className="text-[#8a4b4b]">trust {sel.genes.toolTrust.toFixed(2)}</span>
                      </div>
                      <ul className="max-h-24 overflow-y-auto">
                        {sel.office.readings.map((r, i) => (
                          <li key={i} className="flex gap-1.5"><span className={cn("shrink-0 uppercase", r.ok ? "text-[#86efac]" : "text-[#f87171]")}>{r.desk.replace("desk", "")}</span><span className="truncate text-[#c98a8a]" title={r.summary}>{r.summary}</span><span className="ml-auto shrink-0 text-[#6b4a4a]">{r.ms ? `${(r.ms / 1000).toFixed(1)}s` : ""}</span></li>
                        ))}
                      </ul>
                      {sel.office.notes.length > 0 && <ul className="text-[#fde68a]">{sel.office.notes.map((n, i) => <li key={i}>→ {n}</li>)}</ul>}
                      {sel.office.baseWeights.length > 0 && <p className="text-[#8a4b4b]">before skills: {sel.office.baseWeights.map((w) => `${w.market.replace("KRW-", "")} ${w.weightPct}%`).join(" · ")}</p>}
                    </div>
                  ) : (
                    <p className="mt-1 text-[9.5px] text-[#8a4b4b]">{sel.alive ? "no desk rented — pure formula, free but blind" : "—"}</p>
                  )}
                </div>
                <div>
                  <Label>current targets</Label>
                  <p className="mt-1 text-[9.5px] text-[#c98a8a]">{sel.lastWeights.length ? sel.lastWeights.map((w) => `${w.market.replace("KRW-", "")} ${w.weightPct}%`).join(" · ") : "cash"}</p>
                </div>
                <div>
                  <Label>lineage · tribe {agents.find((a) => a.id === sel.tribe.split("/")[0])?.name ?? sel.tribe}{sel.tribe.includes("/") ? ` · branch ${sel.tribe.split("/")[1]}` : ""}</Label>
                  <ul className="mt-1 max-h-28 overflow-y-auto text-[9.5px]">
                    {sel.events.slice().reverse().map((e, i) => (
                      <li key={i} className="flex gap-2"><span className="shrink-0 text-[#8a4b4b]">g{e.gen}</span><span className={cn("shrink-0 uppercase", e.type === "mutated" ? "text-[#fbbf24]" : e.type === "forked" ? "text-[#86efac]" : e.type === "merged" ? "text-[#93c5fd]" : e.type === "absorbed" || e.type === "retired" ? "text-[#6b7280]" : "text-[#c98a8a]")}>{e.type}</span><span className="truncate text-[#c98a8a]">{e.detail}</span></li>
                    ))}
                  </ul>
                </div>
                <div>
                  <Label>invests in</Label>
                  <p className="mt-1 text-[9.5px] text-[#c98a8a]">{sel.peers.length ? `${(sel.genes.peerAlloc * 100).toFixed(0)}% → ${sel.peers.map((p) => agents.find((a) => a.id === p)?.name ?? p).join(", ")}` : "no peer allocation"}</p>
                </div>
              </div>
            )}
            <div className="border-t border-[#3a1a1e] pt-2">
              <Label>squad · top 3 survivors → portfolio</Label>
              <ul className="mt-1 flex flex-col gap-1 text-[9.5px]">
                {status.squad.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-2"><button type="button" onClick={() => setSelected(m.id)} className="text-[#fecaca] hover:underline">{m.name}</button><span className="text-[#8a4b4b]">{m.archetype}</span><span className="ml-auto text-[#fde68a]">{m.fitness.toFixed(2)}</span></li>
                ))}
                {status.squad.members.length === 0 && <li className="text-[#8a4b4b]">no examined survivors yet</li>}
              </ul>
              <p className="mt-1 text-[9.5px] text-[#c98a8a]">blend: {status.squad.targets.length ? status.squad.targets.map((w) => `${w.market.replace("KRW-", "")} ${w.weightPct}%`).join(" · ") : "—"}</p>
            </div>
          </div>
        </div>

        {/* 하단: 엔진 피드 + Handsel 계보 */}
        <div className="grid border-t border-[#3a1a1e] lg:grid-cols-2">
          <div className="border-b border-[#3a1a1e] lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between px-3 py-1.5"><Label>live engine feed</Label><span className="text-[9px] text-[#8a4b4b]">births · mutations · merges · forks · retirements — newest first</span></div>
            <ul className="max-h-48 overflow-y-auto px-3 pb-2 text-[10px] leading-relaxed">
              {logs.length === 0 && <li className="text-[#8a4b4b]">no events yet — first generation runs 3 minutes after boot</li>}
              {logs.map((l, i) => (
                <li key={`${l.ts}-${i}`} className="flex gap-3"><span className="shrink-0 text-[#8a4b4b]">{t(l.ts)}</span><span className={cn("truncate", l.level === "error" ? "text-[#f87171]" : l.level === "warn" ? "text-[#fbbf24]" : l.level === "ok" ? "text-[#86efac]" : "text-[#c98a8a]")}>{l.message}</span></li>
              ))}
            </ul>
          </div>
          <div>
            <div className="flex items-center justify-between px-3 py-1.5"><Label>handsel office · earn-or-die (real graded agents)</Label><span className="text-[9px] text-[#8a4b4b]">lineage mandate + automaton · testnet</span></div>
            {!lineage ? <p className="px-3 pb-2 text-[10px] text-[#8a4b4b]">loading…</p> : !lineage.configured ? <p className="px-3 pb-2 text-[10px] text-[#8a4b4b]">HANDSEL_MCP_TOKEN 미설정 — Handsel 쪽 계보는 토큰이 있어야 읽힌다</p> : (
              <div className="max-h-48 overflow-y-auto px-3 pb-2 text-[9.5px] leading-relaxed text-[#c98a8a]">
                <pre className="whitespace-pre-wrap">{lineage.automaton}</pre>
                <pre className="mt-2 whitespace-pre-wrap">{lineage.report}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">전부 페이퍼·실데이터입니다. 시험지는 훈련 구간 밖 실캔들이고, 자본은 실현 수익으로만 움직이며, 부모가 자기 자본을 떼어 자식을 낳습니다. 세대 실행과 배치는 owner 로그인이 필요합니다. docs/evolution.md</p>
    </div>
  )
}
