"use client"

import useSWR from "swr"
import { getQuote } from "@/lib/api"
import { useLiveQuote } from "@/hooks/useLiveSocket"
import { fmtPct, fmtPrice, fmtVolume, pnlClass } from "@/lib/format"
import { HaltedBadge, Skeleton } from "@/components/primitives"
import { cn } from "@/lib/utils"

/** Compact top-of-book quote panel: bid / ask / last / spread (US retail data). */
export function QuotePanel({ symbol }: { symbol: string }) {
  const { data: quote, isLoading } = useSWR(`quote-${symbol}`, () => getQuote(symbol))
  const tick = useLiveQuote(symbol)

  if (isLoading || !quote) return <Skeleton className="h-32 w-full" />

  const last = tick?.last ?? quote.last
  const bid = tick?.bid ?? quote.bid
  const ask = tick?.ask ?? quote.ask
  const changePct = tick?.changePct ?? quote.changePct
  const change = tick?.change ?? quote.change
  const volume = tick?.volume ?? quote.volume
  const spread = ask - bid

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground">호가 (Top of Book)</h3>
        {quote.halted && <HaltedBadge />}
      </div>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-2xl font-bold tnum">{fmtPrice(last)}</span>
        <span className={cn("font-mono text-sm tnum", pnlClass(change))}>
          {fmtPrice(change).replace("$", change >= 0 ? "+$" : "$")} ({fmtPct(changePct)})
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-up/10 px-2 py-2">
          <p className="text-[10px] text-muted-foreground">매수호가 (Bid)</p>
          <p className="font-mono text-sm font-semibold tnum text-up">{fmtPrice(bid)}</p>
          <p className="font-mono text-[10px] tnum text-muted-foreground">{quote.bidSize}주</p>
        </div>
        <div className="rounded-md bg-muted px-2 py-2">
          <p className="text-[10px] text-muted-foreground">스프레드</p>
          <p className="font-mono text-sm font-semibold tnum">{fmtPrice(spread)}</p>
          <p className="font-mono text-[10px] tnum text-muted-foreground">
            {last > 0 ? `${((spread / last) * 100).toFixed(3)}%` : "-"}
          </p>
        </div>
        <div className="rounded-md bg-down/10 px-2 py-2">
          <p className="text-[10px] text-muted-foreground">매도호가 (Ask)</p>
          <p className="font-mono text-sm font-semibold tnum text-down">{fmtPrice(ask)}</p>
          <p className="font-mono text-[10px] tnum text-muted-foreground">{quote.askSize}주</p>
        </div>
      </div>
      <dl className="grid grid-cols-4 gap-2 text-center text-[10px]">
        {[
          ["시가", fmtPrice(quote.open)],
          ["고가", fmtPrice(quote.high)],
          ["저가", fmtPrice(quote.low)],
          ["거래량", fmtVolume(volume)],
        ].map(([label, value]) => (
          <div key={label} className="rounded bg-background/40 py-1.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono font-medium tnum">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
