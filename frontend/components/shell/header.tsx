"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import {
  SESSION_LABEL,
  formatEtClock,
  formatKstClock,
  getMarketSession,
  getRegularSessionKstText,
} from "@/lib/time"
import type { MarketSession, WsStatus } from "@/lib/types"
import { useLiveStatus } from "@/hooks/useLiveSocket"
import { KillSwitchButton, useSystemStatus } from "@/components/shell/kill-switch"

const SESSION_BADGE_CLASS: Record<MarketSession, string> = {
  pre: "bg-chart-3/15 text-chart-3",
  regular: "bg-primary/15 text-primary",
  after: "bg-chart-2/15 text-chart-2",
  closed: "bg-muted text-muted-foreground",
}

function SessionClock() {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  if (!now) {
    return <div className="h-9 w-64 animate-pulse rounded-md bg-muted" aria-hidden="true" />
  }
  const session = getMarketSession(now)
  return (
    <div className="flex items-center gap-3">
      <div className="hidden flex-col md:flex">
        <span className="font-mono text-xs tnum text-muted-foreground">
          NY <span className="text-foreground">{formatEtClock(now)}</span>
        </span>
        <span className="font-mono text-xs tnum text-muted-foreground">
          SEL <span className="text-foreground">{formatKstClock(now)}</span>
        </span>
      </div>
      <div className="flex flex-col items-start gap-0.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold",
            SESSION_BADGE_CLASS[session],
          )}
        >
          {session === "regular" && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
          {SESSION_LABEL[session]}
        </span>
        <span className="text-[10px] leading-none text-muted-foreground">{getRegularSessionKstText(now)}</span>
      </div>
    </div>
  )
}

const WS_META: Record<WsStatus, { label: string; dot: string; text: string }> = {
  connected: { label: "연결됨", dot: "bg-primary", text: "text-primary" },
  reconnecting: { label: "재연결중", dot: "bg-warning animate-pulse", text: "text-warning" },
  disconnected: { label: "끊김", dot: "bg-destructive", text: "text-destructive" },
}

function WsIndicator() {
  const status = useLiveStatus()
  const meta = WS_META[status]
  return (
    <div className="flex items-center gap-1.5" aria-live="polite">
      <span className={cn("size-2 rounded-full", meta.dot)} />
      <span className={cn("text-xs font-medium", meta.text)}>{meta.label}</span>
    </div>
  )
}

function ApiGauge() {
  const { data } = useSystemStatus()
  const pct = data?.apiUsagePct ?? 0
  const warn = pct > 80
  return (
    <div className="hidden items-center gap-2 lg:flex" title="KIS API 초당 호출 한도 사용률">
      <span className="text-[10px] text-muted-foreground">API</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", warn ? "bg-warning" : "bg-chart-2")}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className={cn("font-mono text-[10px] tnum", warn ? "text-warning" : "text-muted-foreground")}>{pct}%</span>
    </div>
  )
}

export function AppHeader() {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-4 border-b border-border bg-background/90 px-4 backdrop-blur">
      <SessionClock />
      <div className="flex items-center gap-4">
        <ApiGauge />
        <WsIndicator />
        <KillSwitchButton compact />
      </div>
    </header>
  )
}
