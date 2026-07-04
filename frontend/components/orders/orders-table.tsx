"use client"

import { useState } from "react"
import useSWR, { useSWRConfig } from "swr"
import { toast } from "sonner"
import { cancelOrder, getOrders } from "@/lib/api"
import type { Order, OrderStatus } from "@/lib/types"
import { useLiveChannel } from "@/hooks/useLiveSocket"
import { fmtPrice, pnlClass } from "@/lib/format"
import { formatTsKst } from "@/lib/time"
import { Card, EmptyState, ExchBadge, Modal, Skeleton } from "@/components/primitives"
import { cn } from "@/lib/utils"

type Tab = "open" | "filled" | "all"

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "open", label: "미체결" },
  { key: "filled", label: "체결내역" },
  { key: "all", label: "전체" },
]

const STATUS_LABEL: Record<OrderStatus, string> = {
  open: "미체결",
  partial: "부분체결",
  filled: "체결",
  cancelled: "취소",
  rejected: "거부",
}

const STATUS_CLASS: Record<OrderStatus, string> = {
  open: "bg-chart-2/15 text-chart-2",
  partial: "bg-warning/15 text-warning",
  filled: "bg-primary/15 text-primary",
  cancelled: "bg-muted text-muted-foreground",
  rejected: "bg-destructive/15 text-destructive",
}

function CancelConfirm({
  order,
  onClose,
  onCancelled,
}: {
  order: Order
  onClose: () => void
  onCancelled: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const onConfirm = async () => {
    setSubmitting(true)
    try {
      await cancelOrder(order.orderId)
      toast.success(`주문 취소됨: ${order.symbol} ${order.side === "buy" ? "매수" : "매도"} ${order.qty}주`)
      onCancelled()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "취소 실패")
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="주문 취소 확인">
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed">
          <span className="font-mono font-bold">{order.symbol}</span>{" "}
          <span className={order.side === "buy" ? "text-up" : "text-down"}>
            {order.side === "buy" ? "매수" : "매도"}
          </span>{" "}
          {order.qty}주 @ {fmtPrice(order.price)} 주문을 취소하시겠습니까?
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 flex-1 rounded-md border border-border text-sm font-medium transition-colors hover:bg-accent"
          >
            닫기
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="h-10 flex-1 rounded-md bg-destructive text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "취소 중..." : "주문 취소"}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function OrdersTable() {
  const [tab, setTab] = useState<Tab>("open")
  const { data, isLoading, mutate } = useSWR(`orders-${tab}`, () => getOrders(tab), { refreshInterval: 6000 })
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const { mutate: globalMutate } = useSWRConfig()

  // flash the affected row when a WS execution message arrives
  useLiveChannel(["execution"], (msg) => {
    if (msg.ch !== "execution") return
    setFlashId(msg.data.orderId)
    setTimeout(() => setFlashId(null), 1600)
    mutate()
    globalMutate("balance")
    globalMutate("positions")
  })

  return (
    <Card className="flex flex-col">
      <div className="flex gap-1 border-b border-border p-2" role="tablist" aria-label="주문 목록">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
              tab === t.key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading || !data ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : data.length === 0 ? (
        <EmptyState
          title={tab === "open" ? "미체결 주문이 없습니다" : "주문 내역이 없습니다"}
          hint="좌측 주문 패널에서 새 주문을 실행하세요."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">시각 (KST)</th>
                <th className="px-3 py-2 font-medium">종목</th>
                <th className="px-3 py-2 font-medium">구분</th>
                <th className="px-3 py-2 font-medium">유형/세션</th>
                <th className="px-3 py-2 text-right font-medium">수량</th>
                <th className="px-3 py-2 text-right font-medium">가격</th>
                <th className="px-3 py-2 text-right font-medium">체결가</th>
                <th className="px-3 py-2 font-medium">상태</th>
                <th className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">동작</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((o) => (
                <tr
                  key={o.orderId}
                  className={cn(
                    "border-b border-border/50 transition-colors last:border-0",
                    flashId === o.orderId && "animate-pulse bg-primary/10",
                  )}
                >
                  <td className="px-3 py-2.5 font-mono text-xs tnum text-muted-foreground">
                    {formatTsKst(o.createdAt)}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold">{o.symbol}</span>
                      <ExchBadge exch={o.exch} />
                    </div>
                  </td>
                  <td className={cn("px-3 py-2.5 text-xs font-bold", o.side === "buy" ? "text-up" : "text-down")}>
                    {o.side === "buy" ? "매수" : "매도"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {o.orderType === "limit" ? "지정가" : "시장가"} ·{" "}
                    {o.session === "regular" ? "정규장" : "확장"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tnum">
                    {o.filledQty}/{o.qty}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tnum">{fmtPrice(o.price)}</td>
                  <td className={cn("px-3 py-2.5 text-right font-mono text-xs tnum", o.avgFillPrice > 0 && pnlClass(0))}>
                    {o.avgFillPrice > 0 ? fmtPrice(o.avgFillPrice) : "-"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold", STATUS_CLASS[o.status])}>
                      {STATUS_LABEL[o.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {(o.status === "open" || o.status === "partial") && (
                      <button
                        type="button"
                        onClick={() => setCancelTarget(o)}
                        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        취소
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cancelTarget && (
        <CancelConfirm order={cancelTarget} onClose={() => setCancelTarget(null)} onCancelled={() => mutate()} />
      )}
    </Card>
  )
}
