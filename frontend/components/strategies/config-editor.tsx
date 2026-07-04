"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Modal, inputClass, labelClass } from "@/components/primitives"
import { patchStrategyConfig, ApiError } from "@/lib/api"
import type { OrderSession, Strategy, StrategyConfig } from "@/lib/types"

export function ConfigEditor({
  strategy,
  onClose,
  onSaved,
}: {
  strategy: Strategy | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<StrategyConfig | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (strategy) setForm({ ...strategy.config })
  }, [strategy])

  if (!strategy || !form) return null

  const running = strategy.status === "running"

  function set<K extends keyof StrategyConfig>(key: K, value: StrategyConfig[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f))
  }

  const errors: string[] = []
  if (form.stopLossPct <= 0 || form.stopLossPct > 50) errors.push("손절 비율은 0~50% 사이여야 합니다.")
  if (form.takeProfitPct <= 0 || form.takeProfitPct > 100) errors.push("익절 비율은 0~100% 사이여야 합니다.")
  if (form.maxPositions < 1 || form.maxPositions > 50) errors.push("최대 포지션 수는 1~50 사이여야 합니다.")
  if (form.maxAmountPerSymbolUsd < 100) errors.push("종목당 최대 금액은 $100 이상이어야 합니다.")
  if (!form.entryRule.trim()) errors.push("진입 규칙을 입력하세요.")

  async function save() {
    if (!strategy || !form || errors.length > 0) return
    setSaving(true)
    try {
      await patchStrategyConfig(strategy.id, form)
      toast.success(`${strategy.name} 설정을 저장했습니다.`)
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "설정 저장에 실패했습니다.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`전략 설정 — ${strategy.name}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        {running && (
          <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            실행 중인 전략입니다. 저장 시 다음 진입부터 새 설정이 적용됩니다.
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="cfg-entry" className={labelClass}>
            진입 규칙
          </label>
          <textarea
            id="cfg-entry"
            value={form.entryRule}
            onChange={(e) => set("entryRule", e.target.value)}
            rows={3}
            className={cn(inputClass, "h-auto resize-none py-2 font-mono text-xs leading-relaxed")}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cfg-sl" className={labelClass}>
              {"손절 (%)"}
            </label>
            <input
              id="cfg-sl"
              type="number"
              inputMode="decimal"
              min={0.1}
              max={50}
              step={0.1}
              value={form.stopLossPct}
              onChange={(e) => set("stopLossPct", Number(e.target.value))}
              className={cn(inputClass, "font-mono")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cfg-tp" className={labelClass}>
              {"익절 (%)"}
            </label>
            <input
              id="cfg-tp"
              type="number"
              inputMode="decimal"
              min={0.1}
              max={100}
              step={0.1}
              value={form.takeProfitPct}
              onChange={(e) => set("takeProfitPct", Number(e.target.value))}
              className={cn(inputClass, "font-mono")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cfg-maxpos" className={labelClass}>
              최대 포지션 수
            </label>
            <input
              id="cfg-maxpos"
              type="number"
              inputMode="numeric"
              min={1}
              max={50}
              step={1}
              value={form.maxPositions}
              onChange={(e) => set("maxPositions", Math.round(Number(e.target.value)))}
              className={cn(inputClass, "font-mono")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cfg-maxamt" className={labelClass}>
              {"종목당 최대 금액 ($)"}
            </label>
            <input
              id="cfg-maxamt"
              type="number"
              inputMode="numeric"
              min={100}
              step={100}
              value={form.maxAmountPerSymbolUsd}
              onChange={(e) => set("maxAmountPerSymbolUsd", Number(e.target.value))}
              className={cn(inputClass, "font-mono")}
            />
          </div>
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className={labelClass}>허용 세션</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            {(
              [
                { value: "regular", label: "정규장만" },
                { value: "extended", label: "정규장 + 시간외" },
              ] as { value: OrderSession; label: string }[]
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={form.allowedSession === opt.value}
                onClick={() => set("allowedSession", opt.value)}
                className={cn(
                  "h-9 rounded-md border text-xs font-medium transition-colors",
                  form.allowedSession === opt.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </fieldset>

        {errors.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={saving || errors.length > 0}
            className="h-9 rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </Modal>
  )
}
