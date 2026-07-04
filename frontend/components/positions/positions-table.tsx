"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { ArrowDown, ArrowUp, X } from "lucide-react"
import { getPositions } from "@/lib/api"
import type { Position } from "@/lib/types"
import { useLiveChannel } from "@/hooks/useLiveSocket"
import { fmtPct, fmtPrice, fmtQty, fmtUsd, pnlClass } from "@/lib/format"
import { Card, EmptyState, ExchBadge, HaltedBadge, Skeleton } from "@/components/primitives"
import { CandleChart } from "@/components/positions/candle-chart"
import { QuotePanel } from "@/components/positions/quote-panel"
import { OrderTicketModal, type TicketPrefill } from "@/components/orders/order-ticket"
import { cn } from "@/lib/utils"

type SortKey = "symbol" | "qty" | "avgPrice" | "curPrice" | "pnlUsd" | "pnlPct" | "weightPct"

const COLUMNS: Array<{ key: SortKey; label: string; align?: "right" }> = [
  { key: "symbol", label: "심볼 / 종목명" },
  { key: "qty", label: "보유수량", align: "right" },
  { key: "avgPrice", label: "평단가($)", align: "right" },
  { key: "curPrice", label: "현재가($)", align: "right" },
  { key: "pnlUsd", label: "평가손익($)", align: "right" },
  { key: "pnlPct", label: "수익률%", align: "right" },
  { key: "weightPct", label: "비중%", align: "right" },
]

function DetailDrawer({ position, onClose }: { position: Position; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${position.symbol} 상세`}>
      <button type="button" aria-label="닫기" className="absolute inset-0 bg-black/60" onClick={onClose} tabIndex={-1} />
      <div className="relative flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-border bg-card p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-lg font-bold">{position.symbol}</h2>
            <ExchBadge exch={position.exch} />
            {position.halted && <HaltedBadge />}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="닫기"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">{position.name}</p>
        <QuotePanel symbol={position.symbol} />
        <CandleChart symbol={position.symbol} />
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md bg-muted/50 p-2.5">
            <dt className="text-[10px] text-muted-foreground">보유 / 평단가</dt>
            <dd className="font-mono tnum">
              {fmtQty(position.qty)} @ {fmtPrice(position.avgPrice)}
            </dd>
          </div>
          <div className="rounded-md bg-muted/50 p-2.5">
            <dt className="text-[10px] text-muted-foreground">평가손익</dt>
            <dd className={cn("font-mono tnum", pnlClass(position.pnlUsd))}>
              {fmtUsd(position.pnlUsd, { sign: true })} ({fmtPct(position.pnlPct)})
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}

export function PositionsTable() {
  const { data, isLoading, mutate } = useSWR("positions", () => getPositions(), { refreshInterval: 8000 })
  const [sortKey, setSortKey] = useState<SortKey>("weightPct")
  const [sortDesc, setSortDesc] = useState(true)
  const [detail, setDetail] = useState<Position | null>(null)
  const [sellPrefill, setSellPrefill] = useState<TicketPrefill | null>(null)

  // live position replacement from WS
  useLiveChannel(["position"], (msg) => {
    if (msg.ch === "position") mutate(msg.data, { revalidate: false })
  })

  const sorted = useMemo(() => {
    if (!data) return []
    const arr = [...data]
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number)
      return sortDesc ? -cmp : cmp
    })
    return arr
  }, [data, sortKey, sortDesc])

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc((d) => !d)
    else {
      setSortKey(key)
      setSortDesc(true)
    }
  }

  if (isLoading || !data) {
    return (
      <Card className="p-4">
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </Card>
    )
  }

  return (
    <>
      <Card className="overflow-x-auto">
        {sorted.length === 0 ? (
          <EmptyState title="보유종목이 없습니다" hint="주문 페이지에서 매수 주문을 실행하면 여기에 표시됩니다." />
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {COLUMNS.map((col) => (
                  <th key={col.key} className={cn("px-3 py-2.5", col.align === "right" && "text-right")}>
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {col.label}
                      {sortKey === col.key &&
                        (sortDesc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                    </button>
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right">
                  <span className="sr-only">동작</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr
                  key={p.symbol}
                  className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-accent/40"
                  onClick={() => setDetail(p)}
                >
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold">{p.symbol}</span>
                      <ExchBadge exch={p.exch} />
                      {p.halted && <HaltedBadge />}
                    </div>
                    <span className="text-xs text-muted-foreground">{p.name}</span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono tnum">{p.qty.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right font-mono tnum">{fmtPrice(p.avgPrice)}</td>
                  <td className="px-3 py-3 text-right font-mono tnum">{fmtPrice(p.curPrice)}</td>
                  <td className={cn("px-3 py-3 text-right font-mono tnum", pnlClass(p.pnlUsd))}>
                    {fmtUsd(p.pnlUsd, { sign: true })}
                  </td>
                  <td className={cn("px-3 py-3 text-right font-mono tnum", pnlClass(p.pnlPct))}>{fmtPct(p.pnlPct)}</td>
                  <td className="px-3 py-3 text-right font-mono tnum text-muted-foreground">{p.weightPct.toFixed(1)}%</td>
                  <td className="px-3 py-3 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSellPrefill({ symbol: p.symbol, side: "sell", qty: p.qty })
                      }}
                      disabled={p.halted}
                      className="rounded-md bg-down/15 px-2.5 py-1 text-xs font-semibold text-down transition-colors hover:bg-down/25 disabled:opacity-40"
                    >
                      매도
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {detail && <DetailDrawer position={detail} onClose={() => setDetail(null)} />}
      <OrderTicketModal open={sellPrefill !== null} onClose={() => setSellPrefill(null)} prefill={sellPrefill} />
    </>
  )
}
