"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

interface Settings {
  /** false = 미국식 (상승 초록), true = 한국식 (상승 빨강) */
  krColors: boolean
  setKrColors: (v: boolean) => void
}

const SettingsContext = createContext<Settings | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  // 기본은 한국식(상승 빨강·하락 파랑) — Upbit 사용자에게 미국식은 직관과 반대다. 선택은 브라우저에 남긴다
  const [krColors, setKrColorsState] = useState(true)
  useEffect(() => {
    try { const v = localStorage.getItem("hs:krColors"); if (v === "true" || v === "false") setKrColorsState(v === "true") } catch { /* 저장소 없음 */ }
  }, [])
  const setKrColors = (v: boolean) => { setKrColorsState(v); try { localStorage.setItem("hs:krColors", String(v)) } catch { /* 저장소 없음 */ } }

  useEffect(() => {
    document.documentElement.dataset.krColors = krColors ? "true" : "false"
  }, [krColors])

  return <SettingsContext.Provider value={{ krColors, setKrColors }}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider")
  return ctx
}
