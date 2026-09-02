"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { Building2, CheckCircle2, CircleDashed, XCircle } from "lucide-react"
import { ApiError, getOfficeRoster, getOfficeRun, getOfficeRuns, getOfficeStatus, isBackendNotConfigured, type OfficeRun } from "@/lib/api"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { OfficeGraph } from "@/components/office/office-graph"
import { cn } from "@/lib/utils"

const PHASE_KO: Record<OfficeRun["phase"], string> = {
  hiring: "고용 중",
  escrowed: "escrow 중",
  "escrow-pending": "escrow 재시도 대기",
  working: "오피스 협의 중",
  deciding: "결정 파싱 중",
  executed: "페이퍼 실행됨",
  rejected: "관문 거부",
  failed: "실패",
}

function PhaseIcon({ phase }: { phase: OfficeRun["phase"] }) {
  if (phase === "executed") return <CheckCircle2 className="size-3.5 text-chart-1" aria-hidden="true" />
  if (phase === "rejected" || phase === "failed") return <XCircle className="size-3.5 text-destructive" aria-hidden="true" />
  return <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden="true" />
}

/** conversation.md에서 해당 역할 단계의 산출물 섹션만 잘라낸다 (## 제목 접두 매칭) */
function excerptFor(conversation: string | null, stepTitle: string): string | null {
  if (!conversation) return null
  const lines = conversation.split("\n")
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.slice(3).trim().startsWith(stepTitle))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break }
  return lines.slice(start + 1, end).join("\n").trim()
}

export function OfficePageClient() {
  const [selected, setSelected] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const { data: status, error } = useSWR("office-status", getOfficeStatus, { refreshInterval: 10_000 })
  const { data: roster } = useSWR("office-roster", getOfficeRoster)
  const { data: runs } = useSWR("office-runs", getOfficeRuns, { refreshInterval: 10_000 })
  const { data: detail } = useSWR(selected ? ["office-run", selected] : null, () => getOfficeRun(selected!), { refreshInterval: 15_000 })

  // 기본 선택 = 최신 run
  useEffect(() => {
    if (!selected && runs && runs.length > 0) setSelected(runs[0].id)
  }, [runs, selected])

  const notConfigured = isBackendNotConfigured(error)
  const errorMsg = error instanceof ApiError ? error.message : null
  const run = detail?.run ?? null
  const roleDef = useMemo(() => roster?.roles.find((r) => r.id === role) ?? null, [roster, role])
  const excerpt = useMemo(() => (roleDef ? excerptFor(detail?.conversation ?? null, roleDef.stepTitle) : null), [roleDef, detail])
  const passed = run?.stepStatuses ? Object.values(run.stepStatuses).filter((s) => s === "Completed").length : run?.decision?.steps.filter((s) => s.status === "Completed").length
  const total = run?.steps ?? roster?.roles.length ?? 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Building2 className="size-4 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-lg font-bold">증권 오피스 — {roster ? `${roster.roles.length}개 노드가 협의하고 합의한다` : "대화 → 결정 → 매매"}</h1>
        </div>
        {status && (
          <span className={cn("rounded-md px-2 py-1 font-mono text-[11px] font-semibold", status.enabled && status.configured ? "bg-chart-1/15 text-chart-1" : "bg-muted text-muted-foreground")}>
            {status.configured ? (status.enabled ? `LOOP ON · ${status.intervalHours}h · $${status.budgetUsd}` : "LOOP OFF (수동만)") : "HANDSEL 토큰 미설정"}
            {" · "}
            {status.realMoneyHandsel ? "MAINNET" : "TESTNET"}
            {run ? ` · ${run.id} ${PHASE_KO[run.phase]}${total ? ` · ${passed ?? 0}/${total} 통과` : ""}` : ""}
          </span>
        )}
      </div>

      {notConfigured && (
        <Card className="p-4">
          <EmptyState title="백엔드 미연결" hint="Vercel 환경변수에 BACKEND_TOKEN을 넣으면 실기록이 보입니다." />
        </Card>
      )}
      {!notConfigured && errorMsg && <Card className="p-4 text-xs text-destructive">불러오기 실패: {errorMsg}</Card>}

      {roster ? (
        <OfficeGraph roster={roster} run={run} selected={role} onSelect={setRole} height={540} />
      ) : (
        <Skeleton className="h-[540px] w-full" />
      )}

      <div className="grid gap-4 xl:grid-cols-[300px_1fr_1fr]">
        <Card className="h-fit">
          <div className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">사이클 기록</h2>
          </div>
          {!runs ? (
            <div className="p-4"><Skeleton className="h-40 w-full" /></div>
          ) : runs.length === 0 ? (
            <div className="p-4"><EmptyState title="아직 사이클이 없습니다" hint="HANDSEL_MCP_TOKEN + OFFICE_LOOP=true" /></div>
          ) : (
            <ul className="max-h-[420px] divide-y divide-border/50 overflow-y-auto">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(r.id)}
                    aria-pressed={selected === r.id}
                    className={cn("flex w-full flex-col gap-1 px-4 py-2.5 text-left transition-colors hover:bg-accent", selected === r.id && "bg-primary/10")}
                  >
                    <div className="flex items-center gap-2">
                      <PhaseIcon phase={r.phase} />
                      <span className="font-mono text-xs font-bold">{r.id}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{PHASE_KO[r.phase]}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(r.startedAt).toLocaleString("ko-KR", { hour12: false })} · ${r.budgetUsd} · {r.steps ?? 4}노드
                      {r.execution && ` · 주문 ${r.execution.orders}건`}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="h-fit">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">노드</h2>
            {roleDef && <span className="rounded-sm px-1.5 py-0.5 font-mono text-[10px]" style={{ background: roleDef.color + "22", color: roleDef.color }}>{roleDef.name}</span>}
            {roleDef && run?.stepStatuses?.[roleDef.id] && <span className="ml-auto font-mono text-[10px] text-muted-foreground">{run.stepStatuses[roleDef.id]}</span>}
          </div>
          {!roleDef ? (
            <div className="p-4"><EmptyState title="그래프에서 노드를 클릭하세요" hint="그 에이전트가 무엇을 근거로 무엇을 말했는지 보입니다." /></div>
          ) : (
            <div className="flex flex-col gap-2 p-4 text-[11px]">
              <p><span className="text-muted-foreground">전용 툴 </span><span className="font-mono">{roleDef.tool ?? "없음 — 상류 산출물만 읽고 결정을 쓴다"}</span></p>
              <p><span className="text-muted-foreground">받는 것 </span>{roleDef.dependsOn.length ? roleDef.dependsOn.map((d) => roster?.roles.find((r) => r.id === d)?.nameKo ?? d).join(", ") + "의 산출물" : "없음 (원천 노드)"}{roleDef.reviewOf ? ` · ${roster?.roles.find((r) => r.id === roleDef.reviewOf)?.nameKo ?? roleDef.reviewOf} 산출물을 검토(REVISE 가능)` : ""}</p>
              <p><span className="text-muted-foreground">단계 </span><span className="font-mono">{roleDef.stepTitle}</span></p>
              {excerpt ? (
                <pre className="mt-1 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-[10.5px] leading-relaxed">{excerpt}</pre>
              ) : (
                <p className="text-muted-foreground">이 run에 이 노드의 산출물이 아직 없습니다.</p>
              )}
            </div>
          )}
        </Card>

        <Card className="h-fit">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">결정 — decision.json</h2>
            {run?.decision && (
              <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold", run.decision.executable ? "bg-chart-1/15 text-chart-1" : "bg-destructive/15 text-destructive")}>
                {run.decision.executable ? "EXECUTABLE" : "NOT EXECUTABLE"}
              </span>
            )}
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">{run?.headline ?? ""}</span>
          </div>
          {!run ? (
            <div className="p-4"><EmptyState title="사이클을 선택하세요" hint="왼쪽 목록에서 고르면 결정과 체결이 보입니다." /></div>
          ) : (
            <div className="grid gap-3 p-4 md:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">노드별 채점</p>
                <ul className="font-mono text-[11px]">
                  {roster?.roles.map((r) => {
                    const st = run.stepStatuses?.[r.id] ?? run.decision?.steps.find((s) => s.name.startsWith(r.stepTitle))?.status
                    return (
                      <li key={r.id} className="flex justify-between gap-2">
                        <span className="truncate">{r.nameKo}</span>
                        <span className={st === "Completed" ? "text-chart-1" : st === "❌" || st === "Expired" ? "text-destructive" : "text-muted-foreground"}>{st ?? "-"}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">타깃 비중 ({run.decision?.source ?? "-"})</p>
                <ul className="font-mono text-[11px]">
                  {(run.decision?.targets ?? []).map((t) => (
                    <li key={t.market} className="flex justify-between">
                      <span>{t.market}</span>
                      <span className="font-bold">{t.weightPct}%</span>
                    </li>
                  ))}
                  {run.decision && (
                    <li className="flex justify-between text-muted-foreground"><span>현금</span><span>{run.decision.cashPct}%</span></li>
                  )}
                  {!run.decision && <li className="text-muted-foreground">(결정 전)</li>}
                </ul>
              </div>
              {run.decision && run.decision.reasons.length > 0 && (
                <div className="md:col-span-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                  {run.decision.reasons.map((r) => <p key={r}>· {r}</p>)}
                </div>
              )}
              {run.execution && (
                <div className="md:col-span-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px]">
                  execution.json — {new Date(run.execution.ts).toLocaleString("ko-KR", { hour12: false })} · 주문 {run.execution.orders}건 · 스킵 {run.execution.skipped.length}건
                  {run.execution.error && <span className="text-destructive"> · {run.execution.error}</span>}
                </div>
              )}
              {run.error && <p className="md:col-span-2 text-[11px] text-destructive">오류: {run.error}</p>}
            </div>
          )}
        </Card>
      </div>

      {run && (
        <Card>
          <div className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">대화 원문 — conversation.md</h2>
          </div>
          {detail?.conversation ? (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-foreground/90">{detail.conversation}</pre>
          ) : (
            <div className="p-4"><EmptyState title="대화 원문이 아직 없습니다" hint="오피스가 협의를 끝내면 산출물 전문이 여기 남습니다." /></div>
          )}
        </Card>
      )}
    </div>
  )
}
