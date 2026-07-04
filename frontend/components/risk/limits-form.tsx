"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Card, inputClass, labelClass } from "@/components/primitives"
import { patchRiskLimits, ApiError } from "@/lib/api"
import type { RiskLimits } from "@/lib/types"

type LimitsDraft = Pick<RiskLimits, "maxOrderAmountUsd" | "maxDailyLossUsd" | "maxSymbolWeightPct" | "maxOpenPositions">

const FIELDS: { key: keyof LimitsDraft; label: string; unit: string; min: number; step: number; hint: string }[] = [
  {
    key: "maxOrderAmountUsd",
    label: "1회 주문 최대 금액",
    unit: "$",
    min: 100,
    step: 100,
    hint: "단일 주문이 이 금액을 넘으면 자동 차단됩니다.",
  },
  {
    key: "maxDailyLossUsd",
    label: "일일 최대 손실 한도",
    unit: "$",
    min: 50,
    step: 50,
    hint: "당일 실현 손실이 도달하면 신규 진입이 차단됩니다.",
  },
  {
    key: "maxSymbolWeightPct",
    label: "종목당 최대 비중",
    unit: "%",
    min: 1,
    step: 1,
    hint: "총 평가액 대비 단일 종목 비중 상한입니다.",
  },
  {
    key: "maxOpenPositions",
    label: "최대 동시 보유 종목 수",
    unit: "개",
    min: 1,
    step: 1,
    hint: "전체 전략 합산 기준의 동시 보유 상한입니다.",
  },
]

export function LimitsForm({ limits, onSaved }: { limits: RiskLimits; onSaved: () => void }) {
  const [draft, setDraft] = useState<LimitsDraft>({
    maxOrderAmountUsd: limits.maxOrderAmountUsd,
    maxDailyLossUsd: limits.maxDailyLossUsd,
    maxSymbolWeightPct: limits.maxSymbolWeightPct,
    maxOpenPositions: limits.maxOpenPositions,
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft({
      maxOrderAmountUsd: limits.maxOrderAmountUsd,
      maxDailyLossUsd: limits.maxDailyLossUsd,
      maxSymbolWeightPct: limits.maxSymbolWeightPct,
      maxOpenPositions: limits.maxOpenPositions,
    })
  }, [limits])

  const dirty =
    draft.maxOrderAmountUsd !== limits.maxOrderAmountUsd ||
    draft.maxDailyLossUsd !== limits.maxDailyLossUsd ||
    draft.maxSymbolWeightPct !== limits.maxSymbolWeightPct ||
    draft.maxOpenPositions !== limits.maxOpenPositions

  const errors: string[] = []
  if (draft.maxOrderAmountUsd < 100) errors.push("1회 주문 최대 금액은 $100 이상이어야 합니다.")
  if (draft.maxDailyLossUsd < 50) errors.push("일일 최대 손실 한도는 $50 이상이어야 합니다.")
  if (draft.maxSymbolWeightPct < 1 || draft.maxSymbolWeightPct > 100) errors.push("종목당 최대 비중은 1~100% 사이여야 합니다.")
  if (draft.maxOpenPositions < 1 || draft.maxOpenPositions > 100) errors.push("최대 동시 보유 종목 수는 1~100 사이여야 합니다.")

  async function save() {
    if (!dirty || errors.length > 0) return
    setSaving(true)
    try {
      await patchRiskLimits(draft)
      toast.success("리스크 한도를 저장했습니다.")
      onSaved()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "저장에 실패했습니다.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="p-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">리스크 한도 설정</h2>
          {dirty && <span className="text-[11px] font-medium text-warning">저장되지 않은 변경사항</span>}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <label htmlFor={`limit-${f.key}`} className={labelClass}>
                {f.label} <span className="text-muted-foreground/60">({f.unit})</span>
              </label>
              <input
                id={`limit-${f.key}`}
                type="number"
                inputMode="numeric"
                min={f.min}
                step={f.step}
                value={draft[f.key]}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: Number(e.target.value) }))}
                className={cn(inputClass, "font-mono")}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">{f.hint}</p>
            </div>
          ))}
        </div>

        {errors.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        )}

        <div className="flex justify-end border-t border-border pt-3">
          <button
            type="submit"
            disabled={!dirty || saving || errors.length > 0}
            className="h-9 rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "저장 중..." : "한도 저장"}
          </button>
        </div>
      </form>
    </Card>
  )
}
