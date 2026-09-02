"use client"

import { useState } from "react"
import useSWR from "swr"
import { Building2, CheckCircle2, CircleDashed, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { ApiError, getOfficeRun, getOfficeRuns, getOfficeStatus, isBackendNotConfigured, type OfficeRun } from "@/lib/api"

/**
 * 증권 오피스 — 모델들이 대화하고(Handsel 오피스 4 역할), 자율 결정하고,
 * 채점을 통과한 결정만 페이퍼 매매가 되는 루프의 기록.
 * 화면의 모든 것은 백엔드 볼륨에 남은 run.json / conversation.md 원문이다.
 */

const PHASE_KO: Record<OfficeRun["phase"], string> = {
  hiring: "고용 중",
  escrowed: "escrow 완료",
  working: "오피스 작업 중",
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

export function OfficePageClient() {
  const [selected, setSelected] = useState<string | null>(null)
  const { data: status, error } = useSWR("office-status", getOfficeStatus, { refreshInterval: 10_000 })
  const { data: runs } = useSWR("office-runs", getOfficeRuns, { refreshInterval: 10_000 })
  const { data: detail } = useSWR(selected ? ["office-run", selected] : null, () => getOfficeRun(selected!), { refreshInterval: 15_000 })

  const notConfigured = isBackendNotConfigured(error)
  const errorMsg = error instanceof ApiError ? error.message : null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Building2 className="size-4 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-lg font-bold">증권 오피스 — 대화 → 결정 → 매매</h1>
        </div>
        {status && (
          <span className={cn("rounded-md px-2 py-1 font-mono text-[11px] font-semibold", status.enabled && status.configured ? "bg-chart-1/15 text-chart-1" : "bg-muted text-muted-foreground")}>
            {status.configured ? (status.enabled ? `LOOP ON · ${status.intervalHours}h · $${status.budgetUsd}` : "LOOP OFF (수동만)") : "HANDSEL 토큰 미설정"}
            {" · "}
            {status.realMoneyHandsel ? "MAINNET" : "TESTNET"}
          </span>
        )}
      </div>

      {notConfigured && (
        <Card className="p-4">
          <EmptyState title="백엔드 미연결" hint="Vercel 환경변수에 BACKEND_TOKEN을 넣으면 실기록이 보입니다." />
        </Card>
      )}
      {!notConfigured && errorMsg && <Card className="p-4 text-xs text-destructive">불러오기 실패: {errorMsg}</Card>}

      <Card className="p-4 text-[11px] leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground/80">이 루프가 하는 일</p>
        <p>
          ① 스캐너가 후보 코인을 고르면 ② Handsel 증권 오피스(차트·뉴스·퀀트·리밸런스 4 에이전트)가 각자 실도구로 조사하고 서로의 산출물을 받아 대화한다 ③ 각 산출물은 Handsel 독립 채점을 거친다 — <b className="text-foreground">4단계 전부 통과(pay-only-on-pass)한 결정만</b> ④ 관문(코인당 상한 {status?.gate.maxWeightPct ?? 40}%, 스코프 내 마켓, 합 ≤100%)을 지나 ⑤ 페이퍼 장부를 회전한다. 대화 원문(conversation.md)·결정(decision.json)·체결(execution.json)이 그대로 남는다. 실주문 모드에서는 회전 자체가 거부된다.
        </p>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <Card className="h-fit">
          <div className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">사이클 기록</h2>
          </div>
          {!runs ? (
            <div className="p-4">
              <Skeleton className="h-40 w-full" />
            </div>
          ) : runs.length === 0 ? (
            <div className="p-4">
              <EmptyState title="아직 사이클이 없습니다" hint="HANDSEL_MCP_TOKEN을 넣고 POST /api/office/run 또는 OFFICE_LOOP=true" />
            </div>
          ) : (
            <ul className="divide-y divide-border/50">
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
                      {new Date(r.startedAt).toLocaleString("ko-KR", { hour12: false })} · ${r.budgetUsd}
                      {r.decision && ` · ${r.decision.steps.filter((s) => s.status === "Completed").length}/4 통과`}
                      {r.execution && ` · 주문 ${r.execution.orders}건`}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {!selected ? (
            <Card className="p-6">
              <EmptyState title="사이클을 선택하세요" hint="왼쪽 목록에서 고르면 대화 원문과 결정, 체결이 보입니다." />
            </Card>
          ) : !detail ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <Card>
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                  <h2 className="text-sm font-semibold">결정 — decision.json</h2>
                  {detail.run.decision && (
                    <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold", detail.run.decision.executable ? "bg-chart-1/15 text-chart-1" : "bg-destructive/15 text-destructive")}>
                      {detail.run.decision.executable ? "EXECUTABLE" : "NOT EXECUTABLE"}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">{detail.run.headline ?? ""}</span>
                </div>
                <div className="grid gap-3 p-4 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">단계별 채점</p>
                    <ul className="font-mono text-[11px]">
                      {(detail.run.decision?.steps ?? []).map((s) => (
                        <li key={s.name} className="flex justify-between gap-2">
                          <span className="truncate">{s.name}</span>
                          <span className={s.status === "Completed" ? "text-chart-1" : "text-destructive"}>{s.status}</span>
                        </li>
                      ))}
                      {!detail.run.decision && <li className="text-muted-foreground">(결정 전)</li>}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">타깃 비중 ({detail.run.decision?.source ?? "-"})</p>
                    <ul className="font-mono text-[11px]">
                      {(detail.run.decision?.targets ?? []).map((t) => (
                        <li key={t.market} className="flex justify-between">
                          <span>{t.market}</span>
                          <span className="font-bold">{t.weightPct}%</span>
                        </li>
                      ))}
                      {detail.run.decision && (
                        <li className="flex justify-between text-muted-foreground">
                          <span>현금</span>
                          <span>{detail.run.decision.cashPct}%</span>
                        </li>
                      )}
                    </ul>
                  </div>
                  {detail.run.decision && detail.run.decision.reasons.length > 0 && (
                    <div className="md:col-span-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                      {detail.run.decision.reasons.map((r) => (
                        <p key={r}>· {r}</p>
                      ))}
                    </div>
                  )}
                  {detail.run.execution && (
                    <div className="md:col-span-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px]">
                      execution.json — {new Date(detail.run.execution.ts).toLocaleString("ko-KR", { hour12: false })} · 주문 {detail.run.execution.orders}건 · 스킵 {detail.run.execution.skipped.length}건
                      {detail.run.execution.error && <span className="text-destructive"> · {detail.run.execution.error}</span>}
                    </div>
                  )}
                  {detail.run.error && <p className="md:col-span-2 text-[11px] text-destructive">오류: {detail.run.error}</p>}
                </div>
              </Card>

              <Card>
                <div className="border-b border-border px-4 py-2.5">
                  <h2 className="text-sm font-semibold">대화 원문 — conversation.md</h2>
                </div>
                {detail.conversation ? (
                  <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-foreground/90">{detail.conversation}</pre>
                ) : (
                  <div className="p-4">
                    <EmptyState title="대화 원문이 아직 없습니다" hint="오피스가 작업을 끝내면 산출물 전문이 여기 남습니다." />
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
