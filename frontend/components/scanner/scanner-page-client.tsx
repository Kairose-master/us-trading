"use client"

import { useMemo } from "react"
import useSWR from "swr"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Radar, Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, Skeleton } from "@/components/primitives"
import { fetchDayCandles, fetchTopKrwMarkets, type CryptoCandle } from "@/lib/crypto/upbit"
import { buildTargets, rotationBacktest, scoreCoin, type CoinScore } from "@/lib/crypto/scanner"

/**
 * 알트코인 스캐너 — 업비트 KRW 전 마켓 중 거래대금 상위 유니버스를 브라우저에서
 * 직접 스캔한다 (실데이터, 키 불필요). 위험조정 모멘텀 랭킹 → 상위 K 로테이션
 * 타깃 → 그 규칙의 비용 반영 백테스트 + 다중검정 보정까지 한 화면에.
 *
 * 정직성: 이 화면이 극대화하는 것은 "비용 차감 후 위험조정 기대수익"이라는
 * 시도이지 수익 자체가 아니다. 백테스트는 인샘플 상한선이고, 유니버스 크기만큼
 * 암묵적 다중검정이 있어 Bonferroni 보정 통과 여부를 함께 보여준다.
 */

const UNIVERSE = 20 // 브라우저 호출 수 제한 — 백엔드 스캐너(/api/crypto/scanner)는 30
const CANDLE_DAYS = 200

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx])
      }
    }),
  )
  return out
}

interface ScanData {
  names: Map<string, string>
  scores: CoinScore[]
  series: Map<string, CryptoCandle[]>
}

async function runScan(): Promise<ScanData> {
  const top = await fetchTopKrwMarkets(UNIVERSE)
  const names = new Map(top.map((t) => [t.market, t.koreanName]))
  const series = new Map<string, CryptoCandle[]>()
  await mapLimit(top, 4, async (t) => {
    try {
      const cs = await fetchDayCandles(t.market, CANDLE_DAYS)
      if (cs.length >= 61) series.set(t.market, cs)
    } catch {
      /* 실패 코인은 제외 — 지어내지 않는다 */
    }
  })
  const scores: CoinScore[] = []
  for (const t of top) {
    const cs = series.get(t.market)
    if (!cs) continue
    const sc = scoreCoin(t.market, cs, t.valueKrw24h)
    if (sc) scores.push(sc)
  }
  scores.sort((a, b) => b.score - a.score)
  return { names, scores, series }
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}%`
}

export function ScannerPageClient() {
  const { data, error } = useSWR("altcoin-scan", runScan, { revalidateOnFocus: false, refreshInterval: 10 * 60_000 })

  const portfolio = useMemo(() => (data ? buildTargets(data.scores) : null), [data])
  const bt = useMemo(() => (data ? rotationBacktest(data.series) : null), [data])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">알트코인 스캐너</h1>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-chart-1/15 px-2 py-1 font-mono text-[11px] font-semibold text-chart-1">
          <Radio className="size-3" aria-hidden="true" /> UPBIT LIVE — KRW 거래대금 상위 {UNIVERSE}개 실스캔
        </span>
      </div>

      {error && (
        <Card className="p-4 text-xs text-destructive">스캔 실패: {String((error as Error).message)} — 새로고침으로 재시도</Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        {/* 랭킹 테이블 */}
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5">
            <Radar className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">위험조정 모멘텀 랭킹</h2>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">score = mom20 / vol20 · 자격 = HMM P(강세) ≥ 0.5 · 가중 = 1/GARCH σ</span>
          </div>
          {!data ? (
            <div className="p-4">
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[11px]">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">#</th>
                    <th className="px-3 py-1.5 font-medium">마켓</th>
                    <th className="px-3 py-1.5 font-medium">현재가</th>
                    <th className="px-3 py-1.5 font-medium">score</th>
                    <th className="px-3 py-1.5 font-medium">mom20</th>
                    <th className="px-3 py-1.5 font-medium">mom60</th>
                    <th className="px-3 py-1.5 font-medium">vol20</th>
                    <th className="px-3 py-1.5 font-medium">P(강세)</th>
                    <th className="px-3 py-1.5 font-medium">GARCH σ</th>
                    <th className="px-3 py-1.5 font-medium">24h 대금</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {data.scores.map((s, i) => (
                    <tr key={s.market} className={cn(portfolio?.targets.some((t) => t.market === s.market) && "bg-chart-1/5")}>
                      <td className="px-3 py-1 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1 font-bold">
                        {s.market.replace("KRW-", "")}
                        <span className="ml-1 font-sans text-[10px] font-normal text-muted-foreground">{data.names.get(s.market)}</span>
                      </td>
                      <td className="px-3 py-1">₩{s.priceKrw.toLocaleString()}</td>
                      <td className={cn("px-3 py-1 font-bold", s.score >= 0 ? "text-chart-1" : "text-destructive")}>{s.score}</td>
                      <td className={cn("px-3 py-1", s.mom20Pct >= 0 ? "text-chart-1" : "text-destructive")}>{pct(s.mom20Pct)}</td>
                      <td className={cn("px-3 py-1", s.mom60Pct >= 0 ? "text-chart-1" : "text-destructive")}>{pct(s.mom60Pct)}</td>
                      <td className="px-3 py-1">{s.vol20Pct}%</td>
                      <td className={cn("px-3 py-1", s.pBull >= 0.5 ? "text-chart-1" : "text-muted-foreground")}>{s.pBull} <span className="text-[10px] text-muted-foreground">{s.regime}</span></td>
                      <td className="px-3 py-1">{s.garchSigmaPct}%</td>
                      <td className="px-3 py-1 text-muted-foreground">₩{(s.valueKrw24h / 1e8).toFixed(0)}억</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* 로테이션 타깃 */}
        <Card className="h-fit">
          <div className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">상위 K 로테이션 타깃</h2>
          </div>
          <div className="flex flex-col gap-3 p-4">
            {!portfolio ? (
              <Skeleton className="h-40 w-full" />
            ) : portfolio.targets.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                자격(HMM 강세 레짐 확률 ≥ 0.5 + 양의 위험조정 모멘텀)을 갖춘 코인이 없음 — <b className="text-foreground">100% 현금이 현재 정답</b>이고 그대로 표시한다.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {portfolio.targets.map((t) => (
                  <li key={t.market} className="rounded-md border border-border bg-muted/30 px-3 py-2">
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-xs font-bold">{t.market.replace("KRW-", "")}</span>
                      <span className="font-mono text-sm font-bold text-chart-1">{t.weightPct}%</span>
                    </div>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{t.why}</p>
                  </li>
                ))}
                <li className="flex items-baseline justify-between px-3 py-1">
                  <span className="font-mono text-xs text-muted-foreground">현금</span>
                  <span className="font-mono text-sm font-bold">{portfolio.cashPct}%</span>
                </li>
              </ul>
            )}
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground/80">방법 · 적용</p>
              <p>{portfolio?.method ?? "…"}</p>
              <p className="mt-1">
                페이퍼 장부 적용은 백엔드 <code className="text-chart-2">POST /api/crypto/scanner/rotate</code> — <b>페이퍼 전용</b>이며 실주문 모드에서는 거부된다. <code className="text-chart-2">CRYPTO_SCANNER=true</code>면 24h마다 자동 로테이션.
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* 로테이션 백테스트 */}
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">로테이션 규칙 백테스트 — 이 랭킹이 과거에 통했는가</h2>
          {bt && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {bt.daysUsed}일 · 주 1회 리밸런스 · 수수료 0.05%+슬리피지 0.05%/편도 · 유니버스 {bt.universe}
            </span>
          )}
        </div>
        {!bt ? (
          <div className="p-4">
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <div className="grid gap-4 p-4 lg:grid-cols-[1fr_300px]">
            <div className="h-56 min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={bt.equity} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} width={44} />
                  <Tooltip
                    contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", fontSize: 11 }}
                    formatter={(v, name) => [Number(v).toFixed(3), name === "strategy" ? "로테이션" : name === "benchmarkBtc" ? "BTC 보유" : "동일가중"]}
                  />
                  <Line type="monotone" dataKey="strategy" stroke="var(--chart-1)" dot={false} strokeWidth={1.6} />
                  <Line type="monotone" dataKey="benchmarkBtc" stroke="var(--chart-3)" dot={false} strokeWidth={1.2} />
                  <Line type="monotone" dataKey="benchmarkEqual" stroke="var(--muted-foreground)" dot={false} strokeWidth={1} strokeDasharray="4 3" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-col gap-2">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px]">
                <dt className="text-muted-foreground">로테이션 총수익</dt>
                <dd className={bt.metrics.totalReturnPct >= 0 ? "text-chart-1" : "text-destructive"}>{pct(bt.metrics.totalReturnPct)}</dd>
                <dt className="text-muted-foreground">BTC 단순보유</dt>
                <dd className={bt.metrics.btcReturnPct >= 0 ? "text-chart-1" : "text-destructive"}>{pct(bt.metrics.btcReturnPct)}</dd>
                <dt className="text-muted-foreground">동일가중 보유</dt>
                <dd className={bt.metrics.equalWeightReturnPct >= 0 ? "text-chart-1" : "text-destructive"}>{pct(bt.metrics.equalWeightReturnPct)}</dd>
                <dt className="text-muted-foreground">MDD</dt>
                <dd className="text-destructive">{bt.metrics.maxDrawdownPct}%</dd>
                <dt className="text-muted-foreground">비용 드래그</dt>
                <dd className="text-destructive">-{bt.metrics.costDragPct}%p</dd>
                <dt className="text-muted-foreground">리밸런스</dt>
                <dd>{bt.metrics.rebalances}회</dd>
                <dt className="text-muted-foreground">Sharpe</dt>
                <dd>
                  {bt.stats.sharpeAnnual} ± {bt.stats.sharpeSe}
                </dd>
                <dt className="text-muted-foreground">부트스트랩 p</dt>
                <dd>{bt.stats.bootstrapP}</dd>
                <dt className="text-muted-foreground">다중검정</dt>
                <dd className={bt.stats.survivesMultipleTesting ? "text-chart-1" : "text-destructive"}>
                  {bt.stats.survivesMultipleTesting ? "통과" : `탈락 (α=${bt.stats.bonferroniAlpha})`}
                </dd>
              </dl>
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">{bt.caveat}</p>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
