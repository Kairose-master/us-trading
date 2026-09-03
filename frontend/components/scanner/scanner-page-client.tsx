"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Radar, Radio, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { getScanner, getScannerBacktest, getScannerSpa, getUniverse, isBackendNotConfigured } from "@/lib/api"

/**
 * 알트코인 스캐너 — 백엔드 스캔(/api/crypto/scanner)을 보여준다. 업비트 KRW 거래대금
 * 상위 유니버스의 위험조정 모멘텀 랭킹 → 상위 K 로테이션 타깃 → 비용 반영 백테스트와
 * 다중검정 보정. 브라우저는 Upbit를 직접 부르지 않는다 — 캔들은 백엔드 공유 저장소
 * (초당 8회 토큰 버킷) 하나에서 나오고, 스캔 결과는 백엔드가 캐시한다.
 *
 * 정직성: 이 화면이 극대화하는 것은 "비용 차감 후 위험조정 기대수익"이라는
 * 시도이지 수익 자체가 아니다. 백테스트는 인샘플 상한선이고, 유니버스 크기만큼
 * 암묵적 다중검정이 있어 Bonferroni 보정 통과 여부를 함께 보여준다.
 */

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}%`
}
const ago = (s: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(s)) / 60_000))
  return m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`
}

export function ScannerPageClient() {
  const { data, error, isLoading, mutate } = useSWR("altcoin-scan", () => getScanner(), { revalidateOnFocus: false, refreshInterval: 10 * 60_000 })
  const { data: bt, error: btError } = useSWR("altcoin-scan-bt", getScannerBacktest, { revalidateOnFocus: false, refreshInterval: 60 * 60_000 })
  const { data: uni } = useSWR("crypto-universe", getUniverse, { refreshInterval: 60_000 })
  const { data: spa } = useSWR("altcoin-scan-spa", getScannerSpa, { revalidateOnFocus: false, refreshInterval: 6 * 60 * 60_000 })
  const [busy, setBusy] = useState(false)
  const portfolio = data?.portfolio ?? null

  const onRescan = async () => {
    setBusy(true)
    try {
      await mutate(() => getScanner(true), { revalidate: false })
      toast.success("유니버스 재스캔 완료")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "재스캔 실패")
    } finally {
      setBusy(false)
    }
  }

  if (error && isBackendNotConfigured(error)) return <EmptyState title="백엔드 미연결" hint="BACKEND_URL / BACKEND_TOKEN 이 설정되면 스캔 결과가 보인다." />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">투자 유니버스 — 메이저 + 알트코인</h1>
          <p className="text-xs text-muted-foreground">스캐너는 별개의 도구가 아니다. 여기 자산 전부가 오피스·진화·신호 엔진의 거래 대상이고, 협의회가 그 위에서 결정한다. 아래 랭킹은 자산 특성(모멘텀·변동성·국면)이다.{uni ? ` 현재 유니버스 ${uni.markets.length}개 (메이저 ${uni.majors.length} + 알트 상위 + 보유), ${uni.refreshedAt ? `${ago(uni.refreshedAt)} 갱신` : "갱신 대기"}.` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-chart-1/15 px-2 py-1 font-mono text-[11px] font-semibold text-chart-1">
            <Radio className="size-3" aria-hidden="true" /> UPBIT LIVE — KRW {data ? `${data.krwMarkets}개 중 거래대금 상위 ${data.universe}개` : "스캔 중"}{data ? ` · ${ago(data.ts)}` : ""}
          </span>
          <button type="button" disabled={busy || isLoading} onClick={() => void onRescan()} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"><RefreshCw className="size-3" aria-hidden="true" /> 재스캔</button>
        </div>
      </div>

      {error && !isBackendNotConfigured(error) && (
        <Card className="p-4 text-xs text-destructive">스캔 실패: {error instanceof Error ? error.message : String(error)} — 재스캔으로 재시도</Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5">
            <Radar className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">위험조정 모멘텀 랭킹</h2>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">score = mom20 / vol20 · 자격 = HMM P(강세) ≥ 0.5 · 가중 = 1/GARCH σ</span>
          </div>
          {!data ? (
            <div className="p-4"><Skeleton className="h-64 w-full" /></div>
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
                    <th className="px-3 py-1.5 font-medium">일봉</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {data.scores.map((s, i) => (
                    <tr key={s.market} className={cn(portfolio?.targets.some((t) => t.market === s.market) && "bg-chart-1/5")}>
                      <td className="px-3 py-1 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1 font-bold">{s.market.replace("KRW-", "")}</td>
                      <td className="px-3 py-1">₩{s.priceKrw.toLocaleString()}</td>
                      <td className={cn("px-3 py-1 font-bold", s.score >= 0 ? "text-chart-1" : "text-destructive")}>{s.score}</td>
                      <td className={cn("px-3 py-1", s.mom20Pct >= 0 ? "text-chart-1" : "text-destructive")}>{pct(s.mom20Pct)}</td>
                      <td className={cn("px-3 py-1", s.mom60Pct >= 0 ? "text-chart-1" : "text-destructive")}>{pct(s.mom60Pct)}</td>
                      <td className="px-3 py-1">{s.vol20Pct}%</td>
                      <td className={cn("px-3 py-1", s.pBull >= 0.5 ? "text-chart-1" : "text-muted-foreground")}>{s.pBull} <span className="text-[10px] text-muted-foreground">{s.regime}</span></td>
                      <td className="px-3 py-1">{s.garchSigmaPct}%</td>
                      <td className="px-3 py-1 text-muted-foreground">₩{(s.valueKrw24h / 1e8).toFixed(0)}억</td>
                      <td className="px-3 py-1 text-muted-foreground">{s.days}</td>
                    </tr>
                  ))}
                  {data.scores.length === 0 && (
                    <tr><td colSpan={11} className="px-3 py-6 text-center text-muted-foreground">점수를 낼 수 있는 코인이 없음 — 캔들 저장소가 비었거나 Upbit 응답 실패. 재스캔.</td></tr>
                  )}
                </tbody>
              </table>
              <p className="px-4 py-2 text-[10px] text-muted-foreground">{data.note}</p>
            </div>
          )}
        </Card>

        <Card className="h-fit">
          <div className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">모멘텀 팩터 상위 K (참고)</h2>
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
                이 표는 <b>제안이 아니다</b>. 스캐너 엔진은 없어졌고, 이 유니버스를 오피스·진화·신호 엔진이 각자 읽어 협의회에 제안한다. 실제 결정은 홈의 협의록에서 본다.
              </p>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">데이터 스누핑 검정 — 이 중 최고가 BTC 보유를 이긴 게 실력인가</h2>
          {spa?.result.engine === "arch" && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              Hansen SPA · arch {spa.result.version} · {spa.result.n}일 · 후보 {spa.result.models}개 · 부트스트랩 {spa.result.reps}회 (블록 {spa.result.blockSize})
            </span>
          )}
        </div>
        {!spa ? (
          <div className="p-4 text-xs text-muted-foreground">검정 대기 중…</div>
        ) : spa.result.engine === "unavailable" ? (
          <div className="p-4 text-xs text-muted-foreground">
            검정 못 함 — <span className="font-mono">{spa.result.reason}</span>. p값을 지어내지 않는다.
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-4 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono tnum">
              <span>
                p ={" "}
                <b className={(spa.result.pvalues.consistent ?? 1) < 0.05 ? "text-emerald-300" : "text-rose-300"}>
                  {spa.result.pvalues.consistent === null ? "—" : spa.result.pvalues.consistent.toFixed(3)}
                </b>{" "}
                <span className="text-muted-foreground">(lower {spa.result.pvalues.lower?.toFixed(3) ?? "—"} / upper {spa.result.pvalues.upper?.toFixed(3) ?? "—"})</span>
              </span>
              <span className="text-muted-foreground">벤치마크 {spa.benchmark.replace("KRW-", "")} 보유</span>
              <span>최저손실 후보 <b>{spa.result.best.name}</b> <span className="text-muted-foreground">(평균손실차 {spa.result.best.meanLossDiff.toFixed(5)})</span></span>
            </div>
            <p className="text-muted-foreground">
              {(spa.result.pvalues.consistent ?? 1) < 0.05
                ? `귀무가설(전부 BTC 보유보다 낫지 않다)을 기각한다 — 후보 ${spa.result.models}개를 본 것을 감안해도 최고는 진짜다.`
                : `후보 ${spa.result.models}개를 훑은 것을 감안하면, 최고 성과는 우연으로 설명된다. 이 유니버스에서 "제일 오른 코인"을 고르는 것 자체에는 우위가 없다.`}
            </p>
            <p className="text-muted-foreground">
              StepM(Romano-Wolf, FWER 5%)이 인정한 우월 후보:{" "}
              {spa.result.superiorModels === null ? <span className="font-mono">계산 실패</span> : spa.result.superiorModels.length === 0 ? <b className="text-rose-300">없음</b> : <b className="text-emerald-300 font-mono">{spa.result.superiorModels.join(", ")}</b>}
            </p>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">모멘텀 팩터 백테스트 (참고) — 이 랭킹이 과거에 통했는가</h2>
          {bt && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {bt.daysUsed}일 · {bt.rebalanceDays}일마다 리밸런스 · top {bt.topK} · cap {bt.capPct}% · 유니버스 {bt.universe}
            </span>
          )}
        </div>
        {btError ? (
          <div className="p-4 text-xs text-destructive">백테스트 실패: {btError instanceof Error ? btError.message : String(btError)}</div>
        ) : bt === null ? (
          <div className="p-4 text-xs text-muted-foreground">백테스트할 만큼의 일봉이 아직 없다 (캔들 저장소 채워지는 중).</div>
        ) : !bt ? (
          <div className="p-4"><Skeleton className="h-48 w-full" /></div>
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
                <dd>{bt.stats.sharpeAnnual} ± {bt.stats.sharpeSe}</dd>
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
