"use client"

import useSWR from "swr"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { getPaperEquity } from "@/lib/api"
import { Card, Skeleton } from "@/components/primitives"

export function EquityChart() {
  const { data: raw, isLoading } = useSWR("paper-equity", () => getPaperEquity(2000), { refreshInterval: 60_000 })
  const data = raw?.map((p) => ({ date: p.ts.slice(0, 16).replace("T", " "), equityKrw: p.equityKrw }))

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">크립토 페이퍼 자산 (₩) — 시간별 실기록</h2>
        <span className="text-xs text-muted-foreground">crypto-paper-equity.jsonl</span>
      </div>
      {isLoading || !data ? (
        <Skeleton className="h-56 w-full" />
      ) : (
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                tickFormatter={(d: string) => d.slice(5, 10)}
                tickLine={false}
                axisLine={false}
                minTickGap={32}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                tickFormatter={(v: number) => `₩${(v / 1e6).toFixed(2)}M`}
                tickLine={false}
                axisLine={false}
                width={64}
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
                formatter={(v) => [`₩${Math.round(Number(v)).toLocaleString("ko-KR")}`, "페이퍼 자산"]}
              />
              <Area
                type="monotone"
                dataKey="equityKrw"
                stroke="var(--color-chart-1)"
                strokeWidth={1.5}
                fill="url(#equityFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}
