"use client"

import { useState } from "react"
import useSWR from "swr"
import { MessageSquareText, Newspaper, TrendingDown, TrendingUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { getSentiment, getSentimentFeed } from "@/lib/api"
import { useLiveChannel } from "@/hooks/useLiveSocket"
import type { ScoredNews, SentimentLabel } from "@/lib/types"

const LABEL_CLASS: Record<SentimentLabel, string> = {
  BULLISH: "bg-chart-1/15 text-chart-1",
  BEARISH: "bg-destructive/15 text-destructive",
  NEUTRAL: "bg-muted text-muted-foreground",
}

const LABEL_KO: Record<SentimentLabel, string> = {
  BULLISH: "긍정",
  BEARISH: "부정",
  NEUTRAL: "중립",
}

function fmtScore(score: number): string {
  return `${score > 0 ? "+" : ""}${score.toFixed(2)}`
}

export function SentimentPageClient() {
  const [liveFeed, setLiveFeed] = useState<ScoredNews[]>([])

  const { data: overview, isLoading, mutate } = useSWR("sentiment", getSentiment, { refreshInterval: 5000 })
  const { data: fetchedFeed } = useSWR("sentiment-feed", () => getSentimentFeed(60), { refreshInterval: 5000 })

  useLiveChannel(["sentiment"], (msg) => {
    if (msg.ch !== "sentiment") return
    setLiveFeed((prev) => [...msg.data.scored, ...prev].slice(0, 60))
    void mutate()
  })

  const feed = dedupe([...liveFeed, ...(fetchedFeed ?? [])]).slice(0, 60)
  const scoredSymbols = (overview?.symbols ?? []).filter((s) => s.mentions > 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">마켓 센티먼트</h1>
        <p className="text-[11px] text-muted-foreground/70">
          비정형 소스(뉴스 헤드라인) → 렉시콘 채점 → 심볼별 EMA — 근거 단어가 함께 남습니다
        </p>
      </div>

      {/* 상단 지표 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="flex flex-col gap-1 p-3.5">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {overview && overview.index < 0 ? (
              <TrendingDown className="size-4" aria-hidden="true" />
            ) : (
              <TrendingUp className="size-4" aria-hidden="true" />
            )}
            <span className="text-[11px] font-medium">감성 지수</span>
          </div>
          {!overview ? (
            <Skeleton className="h-6 w-24" />
          ) : (
            <div className="flex items-baseline gap-2">
              <p className="font-mono text-lg font-bold">{fmtScore(overview.index)}</p>
              <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold leading-none", LABEL_CLASS[overview.label])}>
                {overview.label}
              </span>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/60">멘션 가중 평균</p>
        </Card>
        <StatCard
          icon={<MessageSquareText className="size-4" aria-hidden="true" />}
          label="총 멘션"
          value={overview ? overview.totalMentions.toLocaleString() : null}
          hint="채점된 헤드라인 수"
        />
        <StatCard
          icon={<Newspaper className="size-4" aria-hidden="true" />}
          label="데이터 소스"
          value={overview ? `${overview.sources.length}곳` : null}
          hint={overview?.sources.map((s) => s.name).slice(0, 3).join(" · ") || "수집 대기"}
        />
        <StatCard
          icon={<TrendingUp className="size-4" aria-hidden="true" />}
          label="추적 심볼"
          value={overview ? `${overview.symbols.length}종목` : null}
          hint="보유 종목 + 워치리스트"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        {/* 자산별 감성 */}
        <Card className="xl:col-span-2">
          <div className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">자산별 감성</h2>
          </div>
          {isLoading && !overview ? (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={`sym-skel-${i}`} className="h-10 w-full" />
              ))}
            </div>
          ) : scoredSymbols.length === 0 ? (
            <EmptyState title="아직 채점된 헤드라인이 없습니다" hint="뉴스가 수집되면 심볼별 점수가 나타납니다." />
          ) : (
            <ul className="divide-y divide-border/50">
              {scoredSymbols.map((s) => (
                <li key={s.symbol} className="flex flex-col gap-1 px-4 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-bold">{s.symbol}</span>
                      <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold leading-none", LABEL_CLASS[s.label])}>
                        {LABEL_KO[s.label]} {fmtScore(s.score)}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground">멘션 {s.mentions}</span>
                  </div>
                  {/* 점수 게이지: -1 ~ +1 */}
                  <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                    <div
                      className={cn("absolute inset-y-0 rounded-full", s.score >= 0 ? "left-1/2 bg-chart-1" : "right-1/2 bg-destructive")}
                      style={{ width: `${Math.min(50, Math.abs(s.score) * 50)}%` }}
                    />
                  </div>
                  {s.topDriver && <p className="truncate text-[11px] text-muted-foreground/80">주요 동인: {s.topDriver}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 분석 피드 */}
        <Card className="xl:col-span-3">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">실시간 분석 피드</h2>
            <p className="text-[11px] text-muted-foreground/60">점수 근거 단어 포함 · 최근 60건</p>
          </div>
          <div className="max-h-[560px] overflow-y-auto">
            {feed.length === 0 ? (
              <EmptyState title="아직 수집된 헤드라인이 없습니다" hint="뉴스 스트림이 흐르면 채점 결과가 나타납니다." />
            ) : (
              <ul className="divide-y divide-border/50">
                {feed.map((item) => (
                  <li key={item.id} className="flex flex-col gap-1.5 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold">{item.symbol}</span>
                      <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold leading-none", LABEL_CLASS[item.label])}>
                        {item.label} {fmtScore(item.score)}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">신뢰도 {(item.confidence * 100).toFixed(0)}%</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
                        {item.source} · {new Date(item.fetchedAt).toLocaleTimeString("ko-KR", { hour12: false })}
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed text-foreground/90">
                      {item.url ? (
                        <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">
                          {item.title}
                        </a>
                      ) : (
                        item.title
                      )}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {item.evidence.map((w) => (
                        <span key={`${item.id}-${w}`} className="rounded-sm bg-chart-2/10 px-1.5 py-0.5 font-mono text-[10px] text-chart-2">
                          {w}
                        </span>
                      ))}
                      <span className="text-[11px] text-muted-foreground">{item.assessment}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

function dedupe(items: ScoredNews[]): ScoredNews[] {
  const seen = new Set<string>()
  const out: ScoredNews[] = []
  for (const i of items) {
    if (seen.has(i.id)) continue
    seen.add(i.id)
    out.push(i)
  }
  return out
}

function StatCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string | null; hint: string }) {
  return (
    <Card className="flex flex-col gap-1 p-3.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      {value === null ? <Skeleton className="h-6 w-20" /> : <p className="font-mono text-lg font-bold">{value}</p>}
      <p className="truncate text-[10px] text-muted-foreground/60">{hint}</p>
    </Card>
  )
}
