"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Cpu, Play, Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { CRYPTO_MARKETS, fetchDayCandles } from "@/lib/crypto/upbit"
import { FEATURE_NAMES } from "@/lib/ml/features"
import { DEFAULT_PARAMS, type EpochLog } from "@/lib/ml/train"
import { walkForwardValidate, type ValidationReport } from "@/lib/ml/validate"

/**
 * 모델 랩 — 브라우저에서 진짜 로지스틱 회귀를 학습한다 (릴3 "Day 11").
 * 업비트 실캔들 → 피처 8종 → 미니배치 SGD → walk-forward 검증.
 * loss 곡선·스텝 카운터·콘솔 로그 전부 실제 학습의 실측값이다.
 */

const DAYS = 500

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}%`
}

export function LabPageClient() {
  const [market, setMarket] = useState("KRW-BTC")
  const [lr, setLr] = useState(DEFAULT_PARAMS.learningRate)
  const [epochs, setEpochs] = useState(DEFAULT_PARAMS.epochs)
  const [quantile, setQuantile] = useState(0.6)
  const [report, setReport] = useState<ValidationReport | null>(null)
  const [consoleLogs, setConsoleLogs] = useState<string[]>([])
  const [training, setTraining] = useState(false)
  const runSeq = useRef(0)

  const { data: candles, error: candleError } = useSWR(["lab-candles", market], () => fetchDayCandles(market, DAYS), {
    revalidateOnFocus: false,
  })

  // 학습 실행 — 에폭 로그를 배치로 흘려보내 콘솔이 실제 진행처럼 차오르게 한다
  const run = useMemo(
    () => () => {
      if (!candles || candles.length < 200) return
      const seq = ++runSeq.current
      setTraining(true)
      setConsoleLogs([`[INFO] ${market} · ${candles.length}일봉 · lr=${lr} epochs=${epochs} q=${quantile} — 학습 시작`])
      // 렌더 한 프레임 양보 후 동기 학습 (수백 ms)
      setTimeout(() => {
        if (seq !== runSeq.current) return
        const epochLogs: EpochLog[] = []
        try {
          const r = walkForwardValidate(
            candles,
            market,
            { ...DEFAULT_PARAMS, learningRate: lr, epochs },
            quantile,
            0.7,
            (log) => epochLogs.push(log),
          )
          // 에폭 로그를 순차 공개 (계산은 이미 끝난 실측값 — 표시만 스트리밍)
          const lines = epochLogs.map(
            (l) => `[EPOCH ${String(l.epoch).padStart(3, " ")}] loss=${l.loss.toFixed(5)} acc=${(l.accuracy * 100).toFixed(1)}%`,
          )
          let i = 0
          const tick = () => {
            if (seq !== runSeq.current) return
            const chunk = lines.slice(i, i + 6)
            i += 6
            setConsoleLogs((prev) => [...prev, ...chunk])
            if (i < lines.length) setTimeout(tick, 30)
            else {
              setConsoleLogs((prev) => [
                ...prev,
                `[DONE] steps=${r.model.steps} finalLoss=${r.model.finalLoss} threshold=${r.threshold} (q${r.quantile})`,
                `[VALIDATE] OOS ${r.testRange.from}~${r.testRange.to}: annual ${pct(r.outOfSample.annualReturnPct)} vs B&H ${pct(r.outOfSample.benchmarkReturnPct)}`,
              ])
              setReport(r)
              setTraining(false)
            }
          }
          tick()
        } catch (e) {
          setConsoleLogs((prev) => [...prev, `[ERROR] ${String(e)}`])
          setTraining(false)
        }
      }, 30)
    },
    [candles, market, lr, epochs, quantile],
  )

  // 캔들 도착/파라미터 변경 시 자동 재학습
  useEffect(() => {
    run()
  }, [run])

  const m = report?.model
  const oos = report?.outOfSample
  const maxAbsW = m ? Math.max(...m.weights.map((w) => Math.abs(w)), 1e-9) : 1

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">모델 랩 — ML 알파 학습</h1>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-chart-2/15 px-2 py-1 font-mono text-[11px] font-semibold text-chart-2">
          <Radio className="size-3" aria-hidden="true" /> 브라우저 실학습 · 업비트 실캔들 · walk-forward
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[250px_1fr_320px]">
        {/* 하이퍼파라미터 */}
        <Card className="h-fit">
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2.5">
            <Cpu className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-xs font-semibold">하이퍼파라미터</h2>
          </div>
          <div className="flex flex-col gap-4 p-3.5">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              마켓
              <select
                value={market}
                onChange={(e) => setMarket(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground"
              >
                {CRYPTO_MARKETS.map((mk) => (
                  <option key={mk} value={mk}>
                    {mk}
                  </option>
                ))}
              </select>
            </label>
            <Slider label="학습률" value={lr} min={0.005} max={0.3} step={0.005} onChange={setLr} fmt={(v) => v.toFixed(3)} />
            <Slider label="에폭" value={epochs} min={10} max={200} step={5} onChange={setEpochs} fmt={(v) => String(v)} />
            <Slider
              label="롱 임계 분위수"
              value={quantile}
              min={0.5}
              max={0.85}
              step={0.05}
              onChange={setQuantile}
              fmt={(v) => `q${v.toFixed(2)} (상위 ${Math.round((1 - v) * 100)}%)`}
            />
            <button
              type="button"
              onClick={run}
              disabled={!candles || training}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-50"
            >
              <Play className="size-3.5" aria-hidden="true" /> {training ? "학습 중…" : "재학습"}
            </button>
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">
              70% 구간에서만 학습하고 나머지 30%(out-of-sample)에서 검증합니다. 신뢰할 수 있는 숫자는 OOS 쪽뿐입니다.
            </p>
          </div>
        </Card>

        {/* 중앙: loss 곡선 + KPI + 가중치 */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="최종 loss" value={m ? m.finalLoss.toFixed(5) : null} hint={m ? `epoch1 ${m.epochs[0]?.loss.toFixed(4)}에서` : ""} />
            <Kpi label="SGD 스텝" value={m ? m.steps.toLocaleString() : null} hint={m ? `${m.samples}샘플 × ${m.params.epochs}에폭` : ""} />
            <Kpi label="학습 정확도" value={m ? `${(m.finalAccuracy * 100).toFixed(1)}%` : null} hint="in-sample — 참고용" />
            <Kpi
              label="OOS 연환산"
              value={oos ? pct(oos.annualReturnPct) : null}
              hint={oos ? `단순보유 ${pct(oos.benchmarkReturnPct)} · Sharpe ${oos.sharpe}` : ""}
              tone={oos ? (oos.annualReturnPct >= 0 ? "up" : "down") : undefined}
            />
          </div>

          <Card className="p-4">
            <div className="flex items-baseline justify-between pb-2">
              <h2 className="text-sm font-semibold">학습 loss 곡선</h2>
              <span className="text-[11px] text-muted-foreground">log loss / epoch — 실측</span>
            </div>
            {candleError ? (
              <EmptyState title="업비트 캔들을 불러오지 못했습니다" hint={String(candleError)} />
            ) : !m ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={m.epochs} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="var(--color-border)" vertical={false} />
                    <XAxis dataKey="epoch" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} minTickGap={30} />
                    <YAxis
                      tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                      tickFormatter={(v: number) => v.toFixed(3)}
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: "var(--color-muted-foreground)" }}
                      formatter={(v) => [Number(v).toFixed(5), "loss"]}
                    />
                    <Line type="monotone" dataKey="loss" stroke="var(--color-chart-2)" strokeWidth={1.6} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <div className="border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold">학습된 피처 가중치</h2>
              </div>
              {!m ? (
                <div className="p-4">
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : (
                <ul className="flex flex-col gap-1.5 p-3.5">
                  {m.weights.map((w, i) => (
                    <li key={FEATURE_NAMES[i]} className="flex items-center gap-2 font-mono text-[11px]">
                      <span className="w-16 shrink-0 text-muted-foreground">{FEATURE_NAMES[i]}</span>
                      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                        <div
                          className={cn("absolute inset-y-0 rounded-full", w >= 0 ? "left-1/2 bg-chart-1" : "right-1/2 bg-destructive")}
                          style={{ width: `${(Math.abs(w) / maxAbsW) * 50}%` }}
                        />
                      </div>
                      <span className={cn("w-14 shrink-0 text-right", w >= 0 ? "text-chart-1" : "text-destructive")}>{w.toFixed(3)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <div className="border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold">검증 — in-sample vs out-of-sample</h2>
              </div>
              {!report ? (
                <div className="p-4">
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : (
                <table className="w-full font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                      <th className="px-3 py-1.5 font-medium">지표</th>
                      <th className="px-3 py-1.5 font-medium">IS (참고)</th>
                      <th className="px-3 py-1.5 font-medium text-foreground">OOS (신뢰)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    <Row label="연환산" a={pct(report.inSample.annualReturnPct)} b={pct(report.outOfSample.annualReturnPct)} />
                    <Row label="Sharpe" a={String(report.inSample.sharpe)} b={String(report.outOfSample.sharpe)} />
                    <Row label="최대낙폭" a={`${report.inSample.maxDrawdownPct}%`} b={`${report.outOfSample.maxDrawdownPct}%`} />
                    <Row label="승률" a={`${report.inSample.winRatePct}%`} b={`${report.outOfSample.winRatePct}%`} />
                    <Row label="진입/노출" a={`${report.inSample.trades}회·${report.inSample.exposurePct}%`} b={`${report.outOfSample.trades}회·${report.outOfSample.exposurePct}%`} />
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </div>

        {/* 학습 콘솔 */}
        <Card className="flex h-fit max-h-[640px] flex-col">
          <div className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">학습 콘솔</h2>
          </div>
          <div className="min-h-40 flex-1 overflow-y-auto p-3 font-mono text-[10px] leading-relaxed">
            {consoleLogs.length === 0 ? (
              <p className="text-muted-foreground/60">캔들 로딩 중…</p>
            ) : (
              consoleLogs.map((line, i) => (
                <p
                  key={`log-${i}`}
                  className={cn(
                    line.startsWith("[ERROR]") ? "text-destructive" : line.startsWith("[DONE]") || line.startsWith("[VALIDATE]") ? "text-chart-1" : "text-foreground/70",
                  )}
                >
                  {line}
                </p>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  fmt: (v: number) => string
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
      <span className="flex justify-between">
        {label} <span className="font-mono text-foreground">{fmt(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-[var(--color-chart-1)]" />
    </label>
  )
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <tr>
      <td className="px-3 py-1 text-muted-foreground">{label}</td>
      <td className="px-3 py-1 text-muted-foreground">{a}</td>
      <td className="px-3 py-1 font-semibold">{b}</td>
    </tr>
  )
}

function Kpi({ label, value, hint, tone }: { label: string; value: string | null; hint: string; tone?: "up" | "down" }) {
  return (
    <Card className="flex flex-col gap-0.5 p-3">
      <p className="text-[10px] font-medium text-muted-foreground">{label}</p>
      {value === null ? (
        <Skeleton className="h-6 w-16" />
      ) : (
        <p className={cn("font-mono text-lg font-bold", tone === "up" && "text-chart-1", tone === "down" && "text-destructive")}>{value}</p>
      )}
      <p className="truncate text-[10px] text-muted-foreground/60">{hint}</p>
    </Card>
  )
}
