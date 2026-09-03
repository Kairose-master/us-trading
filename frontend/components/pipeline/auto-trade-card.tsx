"use client"

import Link from "next/link"
import useSWR from "swr"
import { Bot, ShieldAlert } from "lucide-react"
import { Card } from "@/components/primitives"
import { getAutoTrade } from "@/lib/api"



/**
 * 자동매매 실행기 카드 — 파이프라인 신호 → 리스크 관문 → 주문.
 * 토글은 백엔드 /api/autotrade와 동일한 규칙(킬스위치 시 켤 수 없음)을 따른다.
 */
export function AutoTradeCard() {
  const { data: status, isLoading } = useSWR("autotrade", getAutoTrade, { refreshInterval: 15_000 })
  // 예전엔 여기 스위치가 있었다. 대시보드 프록시는 이 경로에 쓰기를 열지 않아 스위치가 항상 실패했고,
  // 크립토 집행은 이제 홈의 협의회·스케줄러가 사람 없이 한다. 그래서 상태만 보여준다.
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">집행 경로</h2>
          {status?.killSwitchActive && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
              <ShieldAlert className="size-3" aria-hidden="true" /> 킬스위치 활성화
            </span>
          )}
        </div>
        {status && <span className="font-mono text-[11px] text-muted-foreground">미국 실행기 {status.enabled ? "ON" : "OFF"} · 오늘 체결 {status.executedToday}건 · {status.mock ? "모의" : "실전"}</span>}
      </div>
      <div className="grid gap-2 p-4 text-xs text-muted-foreground md:grid-cols-2">
        <p><b className="text-foreground">크립토(페이퍼)</b> — 파이프라인 신호는 15분마다 홈의 협의회에 제안으로만 올라간다. 다른 제안 매니저가 동의해야 채택되고, 스케줄러가 사람 없이 집행한다. 여기서 켤 것은 없다. <Link href="/" className="underline">Command Center</Link></p>
        <p><b className="text-foreground">미국(KIS)</b> — {isLoading ? "…" : status?.mock ? "KIS 미연결 · 모의 계좌. 신호만으로는 집행하지 않는다." : "실계좌 연결됨 — 실주문은 AUTO_TRADE_ALLOW_REAL 이중 스위치 없이는 열리지 않는다."}</p>
      </div>
    </Card>
  )
}
