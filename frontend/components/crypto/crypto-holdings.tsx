"use client"

import { Bitcoin } from "lucide-react"
import { fmtPct, pnlClass } from "@/lib/format"
import type { Holdings } from "@/lib/types"
import { Card, EmptyState } from "@/components/primitives"
import { cn } from "@/lib/utils"

const krw = (v: number) => `₩${Math.round(v).toLocaleString("ko-KR")}`
const signedKrw = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}₩${Math.abs(Math.round(v)).toLocaleString("ko-KR")}`

/** 크립토 보유 — 데스크 거래 모드에 따라 Upbit 실계좌 또는 페이퍼 장부. 심어 놓은 가짜 포지션은 없다 */
export function CryptoHoldingsCard({ c }: { c: Holdings["crypto"] }) {
  const real = c.mode === "real"
  return (
    <Card className={cn(real && "border-destructive/40")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Bitcoin className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">보유 — Upbit {real ? "실계좌" : "페이퍼 장부"}</h2>
        <span className={cn("rounded-sm px-1.5 py-0.5 font-mono text-[10px]", real ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground")}>
          {real ? `REAL${c.since ? ` · ${c.since.slice(0, 10)}~` : ""}` : `PAPER · 시드 ${krw(c.startKrw)}${c.since ? ` · ${c.since.slice(0, 10)}~` : ""}`}
        </span>
        <span className="ml-auto font-mono text-xs tnum">
          평가 {krw(c.equityKrw)} · <span className={pnlClass(c.pnlKrw)}>{signedKrw(c.pnlKrw)} ({fmtPct(c.pnlPct)})</span> · 현금 {krw(c.cashKrw)}
        </span>
      </div>
      {c.positions.length === 0 ? (
        <div className="p-4">
          <EmptyState title="크립토 보유 없음" hint={real ? "실계좌에 코인이 없습니다. 제어 평면 결정이 집행되면 여기에 쌓입니다." : "제어 평면 결정이 집행되면 여기에 쌓입니다."} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-[11px] text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="px-4 py-2 text-left font-medium">마켓</th>
                <th className="px-3 py-2 text-right font-medium">수량</th>
                <th className="px-3 py-2 text-right font-medium">평단(₩)</th>
                <th className="px-3 py-2 text-right font-medium">현재가(₩)</th>
                <th className="px-3 py-2 text-right font-medium">평가금액</th>
                <th className="px-3 py-2 text-right font-medium">손익</th>
                <th className="px-3 py-2 text-right font-medium">비중</th>
              </tr>
            </thead>
            <tbody className="font-mono tnum">
              {c.positions.map((p) => (
                <tr key={p.symbol} className="border-b border-border/40 last:border-0">
                  <td className="px-4 py-2 font-semibold">KRW-{p.symbol}</td>
                  <td className="px-3 py-2 text-right">{p.qty.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                  <td className="px-3 py-2 text-right">{p.avgKrw.toLocaleString("ko-KR")}</td>
                  <td className="px-3 py-2 text-right">{p.curKrw > 0 ? p.curKrw.toLocaleString("ko-KR") : "—"}</td>
                  <td className="px-3 py-2 text-right">{krw(p.valueKrw)}</td>
                  <td className={cn("px-3 py-2 text-right", pnlClass(p.pnlKrw))}>
                    {signedKrw(p.pnlKrw)} ({fmtPct(p.pnlPct)})
                  </td>
                  <td className="px-3 py-2 text-right">{p.weightPct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
