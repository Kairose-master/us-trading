"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR, { useSWRConfig } from "swr"
import { toast } from "sonner"
import { Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { getBalance, getPositions, getQuote, placeOrder, searchSymbols } from "@/lib/api"
import { useLiveQuote } from "@/hooks/useLiveSocket"
import { fmtKrwRaw, fmtPrice, fmtUsd } from "@/lib/format"
import { ExchBadge, HaltedBadge, Modal, inputClass, labelClass } from "@/components/primitives"
import type { OrderSide, OrderType, OrderSession, SymbolInfo } from "@/lib/types"

export interface TicketPrefill {
  symbol: string
  side?: OrderSide
  qty?: number
}

function SymbolSearch({
  value,
  onSelect,
}: {
  value: SymbolInfo | null
  onSelect: (s: SymbolInfo) => void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const { data: results } = useSWR(open ? `symbol-search-${query}` : null, () => searchSymbols(query))
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor="symbol-search" className={labelClass}>
        종목 검색
      </label>
      <div className="relative mt-1.5">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          id="symbol-search"
          className={cn(inputClass, "pl-8 font-mono uppercase")}
          placeholder="티커 또는 종목명 (예: GME)"
          value={open ? query : value ? value.symbol : query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="symbol-results"
        />
      </div>
      {open && results && (
        <ul
          id="symbol-results"
          role="listbox"
          className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-xl"
        >
          {results.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">검색 결과 없음</li>}
          {results.map((s) => (
            <li key={s.symbol} role="option" aria-selected={value?.symbol === s.symbol}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                onClick={() => {
                  onSelect(s)
                  setQuery("")
                  setOpen(false)
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono font-semibold">{s.symbol}</span>
                  <span className="text-xs text-muted-foreground">{s.name}</span>
                </span>
                <ExchBadge exch={s.exch} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Mandatory confirmation modal with 1s disabled delay on the confirm button. */
function ConfirmOrderModal({
  open,
  onClose,
  onConfirm,
  submitting,
  side,
  symbolInfo,
  qty,
  orderType,
  session,
  price,
  totalUsd,
  fxRate,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  submitting: boolean
  side: OrderSide
  symbolInfo: SymbolInfo
  qty: number
  orderType: OrderType
  session: OrderSession
  price: number | null
  totalUsd: number
  fxRate: number
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!open) return
    setArmed(false)
    const t = setTimeout(() => setArmed(true), 1000)
    return () => clearTimeout(t)
  }, [open])

  const sideLabel = side === "buy" ? "매수" : "매도"

  return (
    <Modal open={open} onClose={onClose} title="주문 확인">
      <div className="flex flex-col gap-4">
        <div
          className={cn(
            "rounded-lg border p-4 text-center",
            side === "buy" ? "border-up/40 bg-up/5" : "border-down/40 bg-down/5",
          )}
        >
          <p className={cn("text-2xl font-bold", side === "buy" ? "text-up" : "text-down")}>{sideLabel}</p>
          <p className="mt-1 font-mono text-xl font-bold tnum">
            {symbolInfo.symbol} {qty.toLocaleString()}주
          </p>
          <p className="mt-1 font-mono text-lg tnum">
            {orderType === "market" ? "시장가" : price !== null ? `지정가 ${fmtPrice(price)}` : "-"}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {session === "extended" ? "세션: 프리·애프터 포함" : "세션: 정규장만"}
          </p>
          <p className="mt-2 font-mono text-base font-semibold tnum">
            예상 총액 {fmtUsd(totalUsd)}{" "}
            <span className="text-xs font-normal text-muted-foreground">≈ {fmtKrwRaw(totalUsd, fxRate)}</span>
          </p>
        </div>
        {session === "extended" && (
          <p className="rounded-md bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning" role="alert">
            {"⚠️ 프리·애프터마켓은 유동성이 낮아 슬리피지가 클 수 있습니다."}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-11 flex-1 rounded-md border border-border text-sm font-medium transition-colors hover:bg-accent"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!armed || submitting}
            className={cn(
              "h-11 flex-1 rounded-md text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40",
              side === "buy" ? "bg-up text-primary-foreground" : "bg-down",
            )}
          >
            {submitting ? "제출 중..." : !armed ? `${sideLabel} 주문 실행 (잠시 후)` : `${sideLabel} 주문 실행`}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function OrderTicket({
  prefill,
  onSubmitted,
}: {
  prefill?: TicketPrefill | null
  onSubmitted?: () => void
}) {
  const [symbolInfo, setSymbolInfo] = useState<SymbolInfo | null>(null)
  const [side, setSide] = useState<OrderSide>("buy")
  const [orderType, setOrderType] = useState<OrderType>("limit")
  const [session, setSession] = useState<OrderSession>("regular")
  const [qtyStr, setQtyStr] = useState("")
  const [priceStr, setPriceStr] = useState("")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const { mutate } = useSWRConfig()

  const { data: balance } = useSWR("balance", () => getBalance())
  const { data: positions } = useSWR("positions", () => getPositions())
  const symbol = symbolInfo?.symbol ?? null
  const { data: quote } = useSWR(symbol ? `quote-${symbol}` : null, () => getQuote(symbol!))
  const tick = useLiveQuote(symbol)
  const last = tick?.last ?? quote?.last ?? 0

  // apply prefill
  useEffect(() => {
    if (!prefill) return
    let cancelled = false
    ;(async () => {
      const matches = await searchSymbols(prefill.symbol)
      const found = matches.find((m) => m.symbol === prefill.symbol)
      if (found && !cancelled) {
        setSymbolInfo(found)
        if (prefill.side) setSide(prefill.side)
        if (prefill.qty) setQtyStr(String(prefill.qty))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [prefill])

  // default price to last when symbol/quote changes
  useEffect(() => {
    if (quote && orderType === "limit" && priceStr === "") {
      setPriceStr(quote.last.toFixed(quote.last < 1 ? 4 : 2))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.symbol])

  const qty = Number.parseInt(qtyStr, 10)
  const qtyValid = Number.isInteger(qty) && qty > 0 && String(qty) === qtyStr.trim()
  const price = orderType === "market" ? null : Number.parseFloat(priceStr)
  const priceValid = orderType === "market" || (price !== null && Number.isFinite(price) && price > 0)
  const effectivePrice = orderType === "market" ? last : (price ?? 0)
  const totalUsd = qtyValid && priceValid ? qty * effectivePrice : 0
  const halted = quote?.halted ?? false

  const heldQty = positions?.find((p) => p.symbol === symbol)?.qty ?? 0
  const maxBuyable = effectivePrice > 0 && balance ? Math.floor(balance.cashUsd / effectivePrice) : 0
  const maxQty = side === "buy" ? maxBuyable : heldQty

  const canSubmit = symbolInfo !== null && qtyValid && priceValid && !halted && (side === "buy" || heldQty >= qty)

  const fxRate = balance?.fxRate ?? 1380

  const priceStep = useMemo(() => (effectivePrice > 0 && effectivePrice < 1 ? "0.0001" : "0.01"), [effectivePrice])

  const submit = async () => {
    if (!symbolInfo || !qtyValid) return
    setSubmitting(true)
    try {
      const res = await placeOrder({
        symbol: symbolInfo.symbol,
        exch: symbolInfo.exch,
        side,
        orderType,
        qty,
        price: orderType === "limit" ? (price ?? undefined) : undefined,
        session,
      })
      toast.success(`주문 접수됨 (${res.orderId}): ${symbolInfo.symbol} ${side === "buy" ? "매수" : "매도"} ${qty}주`)
      setConfirmOpen(false)
      setQtyStr("")
      mutate("orders-open")
      mutate("orders-all")
      mutate("orders-filled")
      mutate("balance")
      onSubmitted?.()
    } catch (e) {
      // 409 risk-limit errors: show the error toast verbatim
      toast.error(e instanceof Error ? e.message : "주문 실패")
      setConfirmOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  const segBtn = (active: boolean, activeClass = "bg-background text-foreground shadow-sm") =>
    cn(
      "flex-1 rounded px-2 py-1.5 text-xs font-semibold transition-colors",
      active ? activeClass : "text-muted-foreground hover:text-foreground",
    )

  return (
    <div className="flex flex-col gap-4">
      <SymbolSearch value={symbolInfo} onSelect={(s) => { setSymbolInfo(s); setPriceStr("") }} />

      {symbolInfo && quote && (
        <div className="flex items-center justify-between rounded-md border border-border bg-background/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold">{symbolInfo.symbol}</span>
            <ExchBadge exch={symbolInfo.exch} />
            {halted && <HaltedBadge />}
          </div>
          <span className="font-mono text-sm font-semibold tnum">{fmtPrice(last)}</span>
        </div>
      )}

      <div className="flex gap-1 rounded-md bg-muted p-0.5" role="radiogroup" aria-label="매수/매도">
        <button
          type="button"
          role="radio"
          aria-checked={side === "buy"}
          onClick={() => setSide("buy")}
          className={segBtn(side === "buy", "bg-up text-primary-foreground shadow-sm")}
        >
          매수
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={side === "sell"}
          onClick={() => setSide("sell")}
          className={segBtn(side === "sell", "bg-down text-white shadow-sm")}
        >
          매도
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>주문 유형</span>
          <div className="flex gap-1 rounded-md bg-muted p-0.5" role="radiogroup" aria-label="주문 유형">
            <button type="button" role="radio" aria-checked={orderType === "limit"} onClick={() => setOrderType("limit")} className={segBtn(orderType === "limit")}>
              지정가
            </button>
            <button type="button" role="radio" aria-checked={orderType === "market"} onClick={() => setOrderType("market")} className={segBtn(orderType === "market")}>
              시장가
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>세션</span>
          <div className="flex gap-1 rounded-md bg-muted p-0.5" role="radiogroup" aria-label="주문 세션">
            <button type="button" role="radio" aria-checked={session === "regular"} onClick={() => setSession("regular")} className={segBtn(session === "regular")}>
              정규장만
            </button>
            <button type="button" role="radio" aria-checked={session === "extended"} onClick={() => setSession("extended")} className={segBtn(session === "extended")}>
              프리·애프터 포함
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="order-qty" className={labelClass}>
            수량 (정수만)
          </label>
          <input
            id="order-qty"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className={cn(inputClass, "font-mono tnum")}
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            placeholder="0"
          />
          <button
            type="button"
            onClick={() => maxQty > 0 && setQtyStr(String(maxQty))}
            className="self-start text-[10px] text-muted-foreground underline-offset-2 hover:underline"
          >
            가능수량: {maxQty.toLocaleString()}주 {side === "buy" ? "(예수금 기준)" : "(보유 기준)"}
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="order-price" className={labelClass}>
            가격 (USD)
          </label>
          <input
            id="order-price"
            type="number"
            min={0}
            step={priceStep}
            inputMode="decimal"
            className={cn(inputClass, "font-mono tnum")}
            value={orderType === "market" ? "" : priceStr}
            onChange={(e) => setPriceStr(e.target.value)}
            placeholder={orderType === "market" ? "시장가" : "0.00"}
            disabled={orderType === "market"}
          />
        </div>
      </div>

      <div className="flex items-baseline justify-between rounded-md bg-muted/50 px-3 py-2.5">
        <span className="text-xs text-muted-foreground">예상 총액</span>
        <span className="text-right">
          <span className="font-mono text-base font-bold tnum">{fmtUsd(totalUsd)}</span>{" "}
          <span className="font-mono text-xs tnum text-muted-foreground">≈ {fmtKrwRaw(totalUsd, fxRate)}</span>
        </span>
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => setConfirmOpen(true)}
        className={cn(
          "h-11 w-full rounded-md text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40",
          side === "buy" ? "bg-up text-primary-foreground" : "bg-down",
        )}
      >
        {halted ? "거래정지 종목" : side === "buy" ? "매수 주문" : "매도 주문"}
      </button>

      {symbolInfo && (
        <ConfirmOrderModal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={submit}
          submitting={submitting}
          side={side}
          symbolInfo={symbolInfo}
          qty={qtyValid ? qty : 0}
          orderType={orderType}
          session={session}
          price={price}
          totalUsd={totalUsd}
          fxRate={fxRate}
        />
      )}
    </div>
  )
}

/** Modal wrapper used by the Positions quick-sell button. */
export function OrderTicketModal({
  open,
  onClose,
  prefill,
}: {
  open: boolean
  onClose: () => void
  prefill: TicketPrefill | null
}) {
  return (
    <Modal open={open} onClose={onClose} title="주문" className="max-w-lg">
      <OrderTicket prefill={prefill} onSubmitted={onClose} />
    </Modal>
  )
}
