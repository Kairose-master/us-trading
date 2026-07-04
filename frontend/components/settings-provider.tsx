"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

interface Settings {
  /** false = 미국식 (상승 초록), true = 한국식 (상승 빨강) */
  krColors: boolean
  setKrColors: (v: boolean) => void
}

const SettingsContext = createContext<Settings | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [krColors, setKrColors] = useState(false)

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
