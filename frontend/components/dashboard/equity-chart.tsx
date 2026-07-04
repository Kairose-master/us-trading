"use client"

import useSWR from "swr"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { getEquityCurve } from "@/lib/api"
import { fmtUsd } from "@/lib/format"
import { Card, Skeleton } from "@/components/primitives"

export function EquityChart() {
  const { data, isLoading } = useSWR("equity-curve", () => getEquityCurve(30))

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">일별 총자산 (USD)</h2>
        <span className="text-xs text-muted-foreground">최근 30일</span>
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
                tickFormatter={(d: string) => d.slice(5)}
                tickLine={false}
                axisLine={false}
                minTickGap={32}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                tickFormatter={(v: number) => `$${Math.round(v).toLocaleString()}`}
                tickLine={false}
                axisLine={false}
                width={56}
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
                formatter={(v) => [fmtUsd(Number(v)), "총자산"]}
              />
              <Area
                type="monotone"
                dataKey="equityUsd"
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
