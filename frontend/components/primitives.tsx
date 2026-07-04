"use client"

import { useEffect, type ReactNode } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Exchange } from "@/lib/types"

const EXCH_LABEL: Record<Exchange, string> = { NAS: "NASDAQ", NYS: "NYSE", AMS: "AMEX" }
const EXCH_CLASS: Record<Exchange, string> = {
  NAS: "bg-chart-2/15 text-chart-2",
  NYS: "bg-primary/15 text-primary",
  AMS: "bg-chart-3/15 text-chart-3",
}

export function ExchBadge({ exch, className }: { exch: Exchange; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none",
        EXCH_CLASS[exch],
        className,
      )}
    >
      {EXCH_LABEL[exch]}
    </span>
  )
}

export function HaltedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-destructive",
        className,
      )}
    >
      거래정지
    </span>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} aria-hidden="true" />
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-lg border border-border bg-card", className)}>{children}</div>
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint && <p className="text-xs text-muted-foreground/60">{hint}</p>}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  className?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="닫기" className="absolute inset-0 bg-black/70" onClick={onClose} tabIndex={-1} />
      <div className={cn("relative w-full max-w-md rounded-lg border border-border bg-popover shadow-2xl", className)}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="닫기"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

export function ProgressBar({ pct, className }: { pct: number; className?: string }) {
  const clamped = Math.min(100, Math.max(0, pct))
  const color = clamped > 90 ? "bg-destructive" : clamped > 70 ? "bg-warning" : "bg-primary"
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)} role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${clamped}%` }} />
    </div>
  )
}

export const inputClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"

export const labelClass = "text-xs font-medium text-muted-foreground"
