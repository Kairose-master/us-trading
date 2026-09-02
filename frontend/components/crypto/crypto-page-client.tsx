"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { FlaskConical, Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { CRYPTO_MARKETS, fetchDayCandles, fetchTickers } from "@/lib/crypto/upbit"
import { runBacktest, SIGNALS } from "@/lib/crypto/backtest"

/**
 * 크립토 알파 리서치 — 업비트 공개 API 실데이터로 브라우저에서 직접
 * 백테스트를 돌린다 (목데이터 아님). 시그널 라이브러리 → KPI → 에쿼티 커브
 * vs 단순보유 → 월별 수익 → 시그널 코드 인스펙터.
 */

const BT_DAYS = 365

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}%`
}

export function CryptoPageClient() {
  const [market, setMarket] = useState("KRW-BTC")
  const [signalId, setSignalId] = useState("momentum-20")

  const { data: tickers } = useSWR("upbit-tickers", () => fetchTickers(), { refreshInterval: 5000 })
  const { data: candles, error: candleError } = useSWR(["upbit-candles", market], () => fetchDayCandles(market, BT_DAYS), {
    revalidateOnFocus: false,
  })

  // 시그널 전체를 실캔들로 백테스트 (라이브러리 사이드바의 성과 미리보기 겸)
  const results = useMemo(() => {
    if (!candles || candles.length < 90) return null
    return new Map(SIGNALS.map((s) => [s.id, runBacktest(candles, s, market)]))
  }, [candles, market])

  const signal = SIGNALS.find((s) => s.id === signalId)!
  const bt = results?.get(signalId) ?? null
  const m = bt?.metrics

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">크립토 알파 리서치</h1>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-chart-1/15 px-2 py-1 font-mono text-[11px] font-semibold text-chart-1">
          <Radio className="size-3" aria-hidden="true" /> UPBIT LIVE — 실데이터 · 브라우저 백테스트
        </span>
      </div>

      {/* 실시간 티커 스트립 (업비트 실시세) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {tickers
          ? tickers.map((t) => (
              <button
                key={t.market}
                type="button"
                onClick={() => setMarket(t.market)}
                aria-pressed={market === t.market}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors",
                  market === t.market ? "border-primary bg-primary/5" : "border-border bg-card hover:border-muted-foreground",
                )}
              >
                <p className="font-mono text-xs font-bold">{t.market}</p>
                <p className="font-mono text-sm">₩{t.priceKrw.toLocaleString()}</p>
                <p className={cn("font-mono text-[11px]", t.changePct >= 0 ? "text-chart-1" : "text-destructive")}>
                  {pct(t.changePct)} (24h)
                </p>
              </button>
            ))
          : CRYPTO_MARKETS.map((mk) => <Skeleton key={mk} className="h-[70px] w-full" />)}
      </div>

      <div className="grid gap-4 xl:grid-cols-[240px_1fr_300px]">
        {/* 시그널 라이브러리 */}
        <Card className="h-fit">
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2.5">
            <FlaskConical className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-xs font-semibold">알파 시그널 라이브러리</h2>
          </div>
          <ul className="flex flex-col p-1.5" role="listbox" aria-label="알파 시그널 선택">
            {SIGNALS.map((s) => {
              const r = results?.get(s.id)
              const active = s.id === signalId
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => setSignalId(s.id)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors",
                      active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <span className="text-xs font-medium">{s.name}</span>
                    {r && (
                      <span className={cn("font-mono text-[10px]", r.metrics.annualReturnPct >= 0 ? "text-chart-1" : "text-destructive")}>
                        연환산 {pct(r.metrics.annualReturnPct)} · Sharpe {r.metrics.sharpe}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </Card>

        {/* 메인: KPI + 에쿼티 커브 + 월별 */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="Sharpe" value={m ? String(m.sharpe) : null} hint="일수익 기준 √365 연환산" />
            <Kpi
              label="연환산 수익"
              value={m ? pct(m.annualReturnPct) : null}
              hint={m ? `단순보유 ${pct(m.benchmarkReturnPct)}` : ""}
              tone={m ? (m.annualReturnPct >= 0 ? "up" : "down") : undefined}
            />
            <Kpi label="최대 낙폭" value={m ? `${m.maxDrawdownPct}%` : null} hint="에쿼티 고점 대비" tone={m ? "down" : undefined} />
            <Kpi label="승률" value={m ? `${m.winRatePct}%` : null} hint={m ? `${m.trades}회 진입 · 노출 ${m.exposurePct}%` : ""} />
          </div>

          <Card className="p-4">
            <div className="flex items-baseline justify-between pb-2">
              <h2 className="text-sm font-semibold">에쿼티 커브 vs 단순보유</h2>
              <span className="text-[11px] text-muted-foreground">
                {market} · 최근 {BT_DAYS}일 일봉 · 1.0 시작
              </span>
            </div>
            {candleError ? (
              <EmptyState title="업비트 캔들을 불러오지 못했습니다" hint={String(candleError)} />
            ) : !bt ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={bt.equity} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="var(--color-border)" vertical={false} />
                    <XAxis
                      dataKey="t"
                      tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                      tickFormatter={(d: string) => d.slice(2, 7)}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={40}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                      tickFormatter={(v: number) => v.toFixed(2)}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--color-popover)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: "var(--color-muted-foreground)" }}
                      formatter={(v, name) => [Number(v).toFixed(3), name === "strategy" ? "전략" : "단순보유"]}
                    />
                    <Line type="monotone" dataKey="benchmark" stroke="var(--color-chart-5)" strokeWidth={1.2} dot={false} />
                    <Line type="monotone" dataKey="strategy" stroke="var(--color-chart-1)" strokeWidth={1.6} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card>
            <div className="border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold">월별 수익률</h2>
            </div>
            {!bt ? (
              <div className="p-4">
                <Skeleton className="h-24 w-full" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                      <th className="px-3 py-1.5 font-medium">월</th>
                      <th className="px-3 py-1.5 font-medium">전략</th>
                      <th className="px-3 py-1.5 font-medium">단순보유</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {bt.monthlyReturns.map((r) => (
                      <tr key={r.month}>
                        <td className="px-3 py-1">{r.month}</td>
                        <td className={cn("px-3 py-1", r.strategyPct >= 0 ? "text-chart-1" : "text-destructive")}>{pct(r.strategyPct)}</td>
                        <td className={cn("px-3 py-1", r.benchmarkPct >= 0 ? "text-chart-1" : "text-destructive")}>{pct(r.benchmarkPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* 시그널 인스펙터 */}
        <Card className="h-fit">
          <div className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">{signal.name}</h2>
          </div>
          <div className="flex flex-col gap-3 p-4">
            <p className="text-xs leading-relaxed text-muted-foreground">{signal.description}</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-chart-2">
              {signal.code}
            </pre>
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground/80">백테스트 규약</p>
              <p>t 종가 시그널 → t+1 수익률 적용 (룩어헤드 없음) · 현물 롱/현금만 · 수수료/슬리피지 미반영 · 데이터: 업비트 일봉 실데이터</p>
            </div>
            {m && (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px]">
                <dt className="text-muted-foreground">누적 수익</dt>
                <dd className={m.totalReturnPct >= 0 ? "text-chart-1" : "text-destructive"}>{pct(m.totalReturnPct)}</dd>
                <dt className="text-muted-foreground">진입 횟수</dt>
                <dd>{m.trades}회</dd>
                <dt className="text-muted-foreground">시장 노출</dt>
                <dd>{m.exposurePct}%</dd>
                <dt className="text-muted-foreground">표본</dt>
                <dd>{bt!.days}일봉</dd>
              </dl>
            )}
          </div>
        </Card>
      </div>
    </div>
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
