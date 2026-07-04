export function fmtUsd(v: number, opts?: { sign?: boolean; decimals?: number }): string {
  const decimals = opts?.decimals ?? 2
  const abs = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  const sign = v < 0 ? "-" : opts?.sign && v > 0 ? "+" : ""
  return `${sign}$${abs}`
}

export function fmtKrw(usd: number, fxRate: number): string {
  const krw = Math.round(usd * fxRate)
  return `≈ ₩${Math.abs(krw).toLocaleString("ko-KR")}${krw < 0 ? " 손실" : ""}`
}

export function fmtKrwRaw(usd: number, fxRate: number): string {
  const krw = Math.round(usd * fxRate)
  const sign = krw < 0 ? "-" : ""
  return `${sign}₩${Math.abs(krw).toLocaleString("ko-KR")}`
}

/** Percentage with explicit sign and 2 decimals: +1.23% / -0.45% */
export function fmtPct(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "-" : ""
  return `${sign}${Math.abs(v).toFixed(2)}%`
}

export function fmtQty(v: number): string {
  return `${v.toLocaleString("en-US")}주`
}

export function fmtVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return v.toLocaleString("en-US")
}

/** Price with 2 decimals, or 4 decimals for sub-$1 prices. */
export function fmtPrice(v: number): string {
  const decimals = Math.abs(v) < 1 ? 4 : 2
  return fmtUsd(v, { decimals })
}

/** Tailwind text color class for a signed value, driven by the up/down convention tokens. */
export function pnlClass(v: number): string {
  if (v > 0) return "text-up"
  if (v < 0) return "text-down"
  return "text-muted-foreground"
}
