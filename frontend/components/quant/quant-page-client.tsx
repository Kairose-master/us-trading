"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Radio, Sigma } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { CRYPTO_MARKETS, fetchDayCandles } from "@/lib/crypto/upbit"
import { buildQuantReport } from "@/lib/quant/report"

/**
 * 퀀트 코어 — 수학 지도의 closed-loop 한 바퀴를 실데이터로:
 * Observe → Infer(HMM 레짐·GARCH 변동성) → Allocate(지수 가중 전문가)
 * → Risk(VaR/ES/Kelly) → Evaluate(부트스트랩·다중검정). 전부 브라우저 실계산.
 */

const DAYS = 500
const REGIME_COLORS = ["var(--color-chart-1)", "var(--color-chart-4)", "var(--color-chart-3)"]
const EXPERT_COLORS = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)", "var(--color-chart-5)"]

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}%`
}

export function QuantPageClient() {
  const [market, setMarket] = useState("KRW-BTC")
  const { data: candles, error } = useSWR(["quant-candles", market], () => fetchDayCandles(market, DAYS), {
    revalidateOnFocus: false,
  })

  const report = useMemo(() => {
    if (!candles || candles.length < 200) return null
    try {
      return buildQuantReport(candles, market)
    } catch {
      return null
    }
  }, [candles, market])

  // 차트 데이터
  const regimeData = useMemo(() => {
    if (!report) return []
    return report.dates.map((t, i) => ({
      t,
      s0: report.regime.filtered[i][0],
      s1: report.regime.filtered[i][1],
      s2: report.regime.filtered[i][2] ?? 0,
    }))
  }, [report])

  const volData = useMemo(() => {
    if (!report) return []
    return report.dates.map((t, i) => ({
      t,
      condVol: +(report.garch.condSigma[i] * Math.sqrt(365) * 100).toFixed(1),
      absRet: +(Math.abs(report.returns[i]) * Math.sqrt(365) * 100).toFixed(1),
    }))
  }, [report])

  const weightData = useMemo(() => {
    if (!report) return []
    return report.dates.map((t, i) => {
      const row: Record<string, number | string> = { t }
      report.allocator.experts.forEach((e, j) => {
        row[e.id] = report.allocator.weightPath[i]?.[j] ?? 0
      })
      return row
    })
  }, [report])

  const st = report?.stats

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold">퀀트 코어</h1>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
            aria-label="마켓 선택"
          >
            {CRYPTO_MARKETS.map((mk) => (
              <option key={mk} value={mk}>
                {mk}
              </option>
            ))}
          </select>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-chart-3/15 px-2 py-1 font-mono text-[11px] font-semibold text-chart-3">
          <Radio className="size-3" aria-hidden="true" /> HMM·GARCH·EW·Kelly·부트스트랩 — 브라우저 실계산
        </span>
      </div>

      {error ? (
        <EmptyState title="업비트 캔들을 불러오지 못했습니다" hint={String(error)} />
      ) : (
        <>
          {/* ① 레짐 필터 */}
          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold">① 레짐 필터 — 가우시안 HMM (K=3, EM 적합)</h2>
              {report && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  filtered P(Z_t | Y₁:t) · EM {report.regime.emIters}회 · logL {report.regime.logLik}
                </span>
              )}
            </div>
            {!report ? (
              <div className="p-4">
                <Skeleton className="h-44 w-full" />
              </div>
            ) : (
              <div className="grid gap-4 p-4 lg:grid-cols-[1fr_280px]">
                <div className="h-44 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={regimeData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }} stackOffset="expand">
                      <CartesianGrid stroke="var(--color-border)" vertical={false} />
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickFormatter={(d: string) => d.slice(2, 7)} tickLine={false} axisLine={false} minTickGap={48} />
                      <YAxis tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tickLine={false} axisLine={false} width={36} />
                      <Tooltip
                        contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                        labelStyle={{ color: "var(--color-muted-foreground)" }}
                        formatter={(v, name) => [`${(Number(v) * 100).toFixed(1)}%`, report.regime.states[Number(String(name).slice(1))]?.label ?? name]}
                      />
                      {report.regime.states.map((_, i) => (
                        <Area key={`s${i}`} type="monotone" dataKey={`s${i}`} stackId="1" stroke={REGIME_COLORS[i]} fill={REGIME_COLORS[i]} fillOpacity={0.5} />
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                  <p className="pt-1 text-center text-[10px] text-muted-foreground/60">레짐 사후확률의 시간 진화 — 에이전트가 t 시점에 실제로 아는 belief</p>
                </div>
                <div className="flex h-fit flex-col gap-2">
                  {report.regime.states.map((s, i) => (
                    <div key={`state-${i}`} className="flex items-center gap-2 font-mono text-[11px]">
                      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: REGIME_COLORS[i] }} />
                      <span className="w-12 shrink-0">{s.label}</span>
                      <span className="text-muted-foreground">
                        μ {(s.mu * 100).toFixed(2)}%/d · σ {(s.sigma * 100).toFixed(2)}%/d
                      </span>
                      <span className="ml-auto font-bold">{(report.regime.current[i] * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                  <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground/70">
                    지금 belief: <span className="font-semibold text-foreground/80">{report.regime.states[report.regime.current.indexOf(Math.max(...report.regime.current))].label}</span>. 전이행렬 대각 {report.regime.transition.map((r, i) => r[i].toFixed(2)).join(" / ")} — 레짐은 끈적하다.
                  </p>
                </div>
              </div>
            )}
          </Card>

          {/* ② 변동성 + ③ 배분 */}
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold">② 조건부 변동성 — GARCH(1,1) MLE</h2>
                {report && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    α={report.garch.alpha} β={report.garch.beta} · 지속성 {report.garch.persistence}
                  </span>
                )}
              </div>
              {!report ? (
                <div className="p-4">
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : (
                <div className="p-4">
                  <div className="h-40 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={volData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                        <CartesianGrid stroke="var(--color-border)" vertical={false} />
                        <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickFormatter={(d: string) => d.slice(2, 7)} tickLine={false} axisLine={false} minTickGap={48} />
                        <YAxis tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} width={44} />
                        <Tooltip
                          contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                          labelStyle={{ color: "var(--color-muted-foreground)" }}
                          formatter={(v, name) => [`${v}%`, name === "condVol" ? "GARCH σ(연)" : "|수익률|(연환산)"]}
                        />
                        <Line type="monotone" dataKey="absRet" stroke="var(--color-chart-5)" strokeWidth={0.8} dot={false} opacity={0.5} />
                        <Line type="monotone" dataKey="condVol" stroke="var(--color-chart-2)" strokeWidth={1.6} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="pt-2 font-mono text-[11px] text-muted-foreground">
                    익일 σ 예측: <span className="font-bold text-foreground">{(report.garch.forecastSigma * Math.sqrt(365) * 100).toFixed(1)}%</span> (연환산) · 장기 σ {Number.isNaN(report.garch.longRunSigma) ? "—" : `${(report.garch.longRunSigma * Math.sqrt(365) * 100).toFixed(1)}%`}
                  </p>
                </div>
              )}
            </Card>

            <Card>
              <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold">③ 온라인 배분 — 지수 가중 (w ∝ w·e^ηr)</h2>
                {report && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    η={report.allocator.eta} · 블렌드 연 {pct(report.allocator.blendedAnnualPct)} · Sharpe {report.allocator.blendedSharpe}
                  </span>
                )}
              </div>
              {!report ? (
                <div className="p-4">
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : (
                <div className="p-4">
                  <div className="h-40 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={weightData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                        <CartesianGrid stroke="var(--color-border)" vertical={false} />
                        <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickFormatter={(d: string) => d.slice(2, 7)} tickLine={false} axisLine={false} minTickGap={48} />
                        <YAxis tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tickLine={false} axisLine={false} width={36} domain={[0, 1]} />
                        <Tooltip
                          contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                          labelStyle={{ color: "var(--color-muted-foreground)" }}
                          formatter={(v, name) => [`${(Number(v) * 100).toFixed(1)}%`, name]}
                        />
                        {report.allocator.experts.map((e, i) => (
                          <Line key={e.id} type="monotone" dataKey={e.id} stroke={EXPERT_COLORS[i]} strokeWidth={1.3} dot={false} />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 pt-2 font-mono text-[10px]">
                    {report.allocator.experts.map((e, i) => (
                      <span key={`legend-${e.id}`} className="inline-flex items-center gap-1">
                        <span className="size-2 rounded-sm" style={{ background: EXPERT_COLORS[i] }} />
                        {e.name} <span className="font-bold">{(e.finalWeight * 100).toFixed(0)}%</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* ④ 리스크/사이징 + ⑤ 통계 */}
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <div className="border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold">④ 리스크 · 사이징 (블렌드 포트폴리오)</h2>
              </div>
              {!report ? (
                <div className="p-4">
                  <Skeleton className="h-28 w-full" />
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2 p-3.5 sm:grid-cols-6">
                  <Mini label="VaR 95%" value={`${report.risk.var95Pct}%/d`} />
                  <Mini label="ES 95%" value={`${report.risk.es95Pct}%/d`} />
                  <Mini label="최대낙폭" value={`${report.risk.maxDrawdownPct}%`} sub={`B&H ${report.benchmarkRisk.maxDrawdownPct}%`} />
                  <Mini label="연변동성" value={`${report.risk.annVolPct}%`} />
                  <Mini label="하방편차" value={`${report.risk.downsideDevPct}%`} />
                  <Mini
                    label="½ Kelly"
                    value={String(report.kelly.halfKelly)}
                    sub={report.kelly.fullKelly === 0 ? "베팅 근거 없음" : `full ${report.kelly.fullKelly}`}
                    tone={report.kelly.fullKelly === 0 ? "down" : "up"}
                  />
                </div>
              )}
            </Card>

            <Card>
              <div className="border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold">⑤ 백테스트 통계 — 이 성과가 우연인가</h2>
              </div>
              {!st ? (
                <div className="p-4">
                  <Skeleton className="h-28 w-full" />
                </div>
              ) : (
                <div className="flex flex-col gap-2 p-3.5">
                  <div className="grid grid-cols-3 gap-2">
                    <Mini label="Sharpe (연)" value={`${st.sharpeAnnual} ± ${st.sharpeSe}`} sub={`95% CI ${st.sharpeCi95[0]} ~ ${st.sharpeCi95[1]}`} />
                    <Mini label="부트스트랩 p" value={String(st.bootstrapP)} sub={`블록 ${st.blockLen}일 × ${st.bootstrapIters}회`} />
                    <Mini label="Bonferroni α" value={String(st.bonferroniAlpha)} sub={`${st.strategiesTested}개 전략 테스트`} />
                  </div>
                  <p
                    className={cn(
                      "rounded-md px-3 py-2 text-[11px] font-semibold",
                      st.survivesMultipleTesting ? "bg-chart-1/15 text-chart-1" : "bg-warning/15 text-warning",
                    )}
                  >
                    {st.survivesMultipleTesting
                      ? "다중검정 통과 — 이 구간에서 우연으로 보기 어려운 성과"
                      : "다중검정 통과 못 함 — 이 성과는 우연일 수 있다. 자기상관을 보존한 블록 부트스트랩 기준이며, 이 경고를 지우는 유일한 방법은 더 좋은 전략이지 더 많은 테스트가 아니다."}
                  </p>
                </div>
              )}
            </Card>
          </div>

          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <Sigma className="size-3.5" aria-hidden="true" />
            Observe → Infer(①②) → Allocate(③) → Risk(④) → Evaluate(⑤) — 수학 지도의 closed-loop. 실행(Execution)은 자동매매 실행기(파이프라인 탭)가, 예측(ML)은 모델 랩이 담당한다.
          </p>
        </>
      )}
    </div>
  )
}

function Mini({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-md border border-border bg-background px-2.5 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={cn("font-mono text-sm font-bold", tone === "up" && "text-chart-1", tone === "down" && "text-warning")}>{value}</p>
      {sub && <p className="truncate font-mono text-[9px] text-muted-foreground/60">{sub}</p>}
    </div>
  )
}
