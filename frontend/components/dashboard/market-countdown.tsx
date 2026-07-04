"use client"

import { useEffect, useState } from "react"
import { Moon } from "lucide-react"
import { formatCountdown, getMarketSession, getNextRegularOpen } from "@/lib/time"

/** "오늘 밤 장 시작까지" countdown, shown only when the market is closed. */
export function MarketCountdown() {
  const [remaining, setRemaining] = useState<number | null>(null)

  useEffect(() => {
    const update = () => {
      const now = new Date()
      if (getMarketSession(now) !== "closed") {
        setRemaining(null)
        return
      }
      setRemaining(getNextRegularOpen(now).getTime() - now.getTime())
    }
    update()
    const t = setInterval(update, 1000)
    return () => clearInterval(t)
  }, [])

  if (remaining === null) return null

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
      <Moon className="size-3.5 text-chart-2" aria-hidden="true" />
      <span className="text-xs text-muted-foreground">오늘 밤 장 시작까지</span>
      <span className="font-mono text-xs font-semibold tnum text-foreground">{formatCountdown(remaining)}</span>
    </div>
  )
}
