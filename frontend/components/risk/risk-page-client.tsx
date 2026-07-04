"use client"

import { useState } from "react"
import useSWR, { useSWRConfig } from "swr"
import { toast } from "sonner"
import { ShieldCheck } from "lucide-react"
import { Card, Skeleton } from "@/components/primitives"
import { KillSwitchButton, useSystemStatus } from "@/components/shell/kill-switch"
import { LimitsForm } from "@/components/risk/limits-form"
import { UsagePanel } from "@/components/risk/usage-panel"
import { getRiskLimits, deactivateKillSwitch } from "@/lib/api"

function KillSwitchPanel() {
  const { data: status } = useSystemStatus()
  const { mutate } = useSWRConfig()
  const [resuming, setResuming] = useState(false)
  const active = status?.killSwitchActive ?? false

  async function resume() {
    setResuming(true)
    try {
      await deactivateKillSwitch()
      toast.success("킬 스위치를 해제했습니다. 전략은 개별적으로 다시 시작해야 합니다.")
      mutate("system-status")
    } catch {
      toast.error("킬 스위치 해제에 실패했습니다.")
    } finally {
      setResuming(false)
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">긴급 정지 (Kill Switch)</h2>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        실행 중인 모든 전략을 즉시 정지하고 자동 주문을 차단합니다. 해제 후에도 전략은 자동으로 재시작되지 않으며,
        전략 페이지에서 수동으로 다시 시작해야 합니다.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <KillSwitchButton />
        {active && (
          <button
            type="button"
            onClick={resume}
            disabled={resuming}
            className="h-10 rounded-md border border-border px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resuming ? "해제 중..." : "킬 스위치 해제"}
          </button>
        )}
      </div>
      {active && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
          현재 킬 스위치가 활성화되어 있습니다. 모든 자동매매가 중단된 상태입니다.
        </p>
      )}
    </Card>
  )
}

export function RiskPageClient() {
  const { data: limits, isLoading, mutate } = useSWR("risk-limits", () => getRiskLimits(), {
    refreshInterval: 8000,
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-lg font-semibold">리스크 관리</h1>
        <p className="text-xs text-muted-foreground">주문 한도와 손실 한도를 설정하고 사용량을 모니터링합니다.</p>
      </div>

      {isLoading && !limits ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-96" />
          <div className="flex flex-col gap-4">
            <Skeleton className="h-48" />
            <Skeleton className="h-44" />
          </div>
        </div>
      ) : limits ? (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <LimitsForm limits={limits} onSaved={() => mutate()} />
          <div className="flex flex-col gap-4">
            <UsagePanel limits={limits} />
            <KillSwitchPanel />
          </div>
        </div>
      ) : null}
    </div>
  )
}
