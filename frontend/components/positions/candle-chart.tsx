"use client"

import { useState } from "react"
import useSWR from "swr"
import { Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { getChart } from "@/lib/api"
import { fmtPrice } from "@/lib/format"
import { Skeleton } from "@/components/primitives"
import { cn } from "@/lib/utils"

type Interval = "1m" | "5m" | "1d"

interface CandleDatum {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
  range: [number, number] // [low, high] for the bar
}

function CandleShape(props: {
  x?: number
  y?: number
  width?: number
  height?: number
  payload?: CandleDatum
}) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props
  if (!payload || height <= 0) return <g />
  const { o, h, l, c } = payload
  const up = c >= o
  const color = up ? "var(--color-up)" : "var(--color-down)"
  const pxPerUnit = height / (h - l || 1)
  const bodyTop = y + (h - Math.max(o, c)) * pxPerUnit
  const bodyH = Math.max(1, Math.abs(o - c) * pxPerUnit)
  const cx = x + width / 2
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={x + width * 0.18} y={bodyTop} width={width * 0.64} height={bodyH} fill={color} />
    </g>
  )
}

export function CandleChart({ symbol }: { symbol: string }) {
  const [interval, setInterval] = useState<Interval>("5m")
  const { data, isLoading } = useSWR(`chart-${symbol}-${interval}`, () => getChart(symbol, interval, 120))

  const chartData: CandleDatum[] = (data ?? []).map((c) => ({ ...c, range: [c.l, c.h] }))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground">차트</h3>
        <div className="flex gap-1 rounded-md bg-muted p-0.5" role="radiogroup" aria-label="차트 주기">
          {(["1m", "5m", "1d"] as const).map((iv) => (
            <button
              key={iv}
              type="button"
              role="radio"
              aria-checked={interval === iv}
              onClick={() => setInterval(iv)}
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[10px] font-medium transition-colors",
                interval === iv ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {iv === "1d" ? "일봉" : iv}
            </button>
          ))}
        </div>
      </div>
      {isLoading || !data ? (
        <Skeleton className="h-52 w-full" />
      ) : (
        <div className="h-52 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="t"
                tick={{ fontSize: 9, fill: "var(--color-muted-foreground)" }}
                tickFormatter={(t: string) =>
                  interval === "1d"
                    ? t.slice(5, 10)
                    : new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })
                }
                tickLine={false}
                axisLine={false}
                minTickGap={48}
              />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fontSize: 9, fill: "var(--color-muted-foreground)" }}
                tickFormatter={(v: number) => v.toFixed(v < 1 ? 3 : v < 100 ? 1 : 0)}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--color-popover)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 11,
                }}
                labelFormatter={(t) => new Date(String(t)).toLocaleString("ko-KR", { hour12: false })}
                formatter={(_v, _n, item) => {
                  const p = item?.payload as CandleDatum | undefined
                  if (!p) return ["-", ""]
                  return [`시 ${fmtPrice(p.o)} 고 ${fmtPrice(p.h)} 저 ${fmtPrice(p.l)} 종 ${fmtPrice(p.c)}`, "OHLC"]
                }}
              />
              <Bar dataKey="range" shape={<CandleShape />} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
