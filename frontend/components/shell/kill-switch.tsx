"use client"

import { useState } from "react"
import useSWR, { useSWRConfig } from "swr"
import { toast } from "sonner"
import { OctagonX } from "lucide-react"
import { activateKillSwitch, getSystemStatus } from "@/lib/api"
import { Modal, inputClass } from "@/components/primitives"
import { cn } from "@/lib/utils"

export function useSystemStatus() {
  return useSWR("system-status", () => getSystemStatus(), { refreshInterval: 4000 })
}

export function KillSwitchButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const { data: status } = useSystemStatus()
  const { mutate } = useSWRConfig()

  const active = status?.killSwitchActive ?? false

  const onActivate = async () => {
    if (confirmText !== "정지") return
    setSubmitting(true)
    try {
      const res = await activateKillSwitch()
      toast.success(`전체 자동매매 정지됨 — 중지된 전략 ${res.stoppedStrategies.length}개`)
      mutate("system-status")
      mutate("strategies")
      setOpen(false)
      setConfirmText("")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "킬 스위치 실행 실패")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={active}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md bg-destructive font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50",
          compact ? "px-2.5 py-1.5 text-xs" : "px-4 py-2.5 text-sm",
        )}
      >
        <OctagonX className={compact ? "size-3.5" : "size-4"} />
        {active ? "정지됨" : "전체 자동매매 정지"}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="⛔ 전체 자동매매 정지 (KILL SWITCH)">
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            실행 중인 <span className="font-semibold text-foreground">모든 전략이 즉시 정지</span>되며, 자동 주문이
            중단됩니다. 재개는 수동으로만 가능합니다.
          </p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="kill-confirm" className="text-xs font-medium text-muted-foreground">
              계속하려면 <span className="font-mono font-bold text-destructive">정지</span> 를 입력하세요
            </label>
            <input
              id="kill-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className={inputClass}
              placeholder="정지"
              autoComplete="off"
            />
          </div>
          <button
            type="button"
            onClick={onActivate}
            disabled={confirmText !== "정지" || submitting}
            className="h-11 w-full rounded-md bg-destructive text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {submitting ? "정지 중..." : "전체 자동매매 정지 실행"}
          </button>
        </div>
      </Modal>
    </>
  )
}

export function KillSwitchBanner() {
  const { data: status } = useSystemStatus()
  if (!status?.killSwitchActive) return null
  return (
    <div
      role="alert"
      className="flex w-full items-center justify-center gap-2 bg-destructive px-4 py-2 text-center text-sm font-bold text-white"
    >
      {"⛔ 자동매매 전체 정지됨 — 수동으로 재개 필요"}
    </div>
  )
}
