"use client"

import useSWR from "swr"
import { getQuote } from "@/lib/api"
import { useLiveQuote } from "@/hooks/useLiveSocket"
import { fmtPct, fmtPrice, pnlClass } from "@/lib/format"
import { Card, ExchBadge, HaltedBadge, Skeleton } from "@/components/primitives"
import { cn } from "@/lib/utils"

const WATCHLIST = ["GME", "MARA", "COIN", "AAPL", "BMNR", "NVDA", "TSLA"]

function TickerItem({ symbol }: { symbol: string }) {
  const { data: quote, error } = useSWR(`quote-${symbol}`, () => getQuote(symbol), { refreshInterval: 15_000 })
  const tick = useLiveQuote(symbol)

  if (!quote && error) {
    return (
      <div className="flex w-36 shrink-0 flex-col gap-0.5 rounded-md border border-dashed border-border px-3 py-2" title={error instanceof Error ? error.message : "시세 미수신"}>
        <span className="font-mono text-xs font-bold">{symbol}</span>
        <span className="text-[11px] text-muted-foreground">시세 미수신</span>
      </div>
    )
  }
  if (!quote) return <Skeleton className="h-16 w-36 shrink-0" />

  const last = tick?.last ?? quote.last
  const changePct = tick?.changePct ?? quote.changePct

  return (
    <div className="flex w-36 shrink-0 flex-col gap-0.5 rounded-md border border-border bg-background/40 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs font-bold">{symbol}</span>
        <ExchBadge exch={quote.exch} />
      </div>
      {quote.halted ? (
        <HaltedBadge className="w-fit" />
      ) : (
        <>
          <span className="font-mono text-sm font-semibold tnum">{fmtPrice(last)}</span>
          <span className={cn("font-mono text-xs tnum", pnlClass(changePct))}>{fmtPct(changePct)}</span>
        </>
      )}
    </div>
  )
}

export function TickerStrip() {
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold">관심종목</h2>
        <span className="text-[10px] text-muted-foreground">실시간 (WS)</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {WATCHLIST.map((s) => (
          <TickerItem key={s} symbol={s} />
        ))}
      </div>
    </Card>
  )
}
