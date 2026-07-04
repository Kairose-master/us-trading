"use client"

import type { ReactNode } from "react"
import { Toaster, toast } from "sonner"
import { LiveSocketProvider, useLiveChannel } from "@/hooks/useLiveSocket"
import { SettingsProvider } from "@/components/settings-provider"
import { AppSidebar } from "@/components/shell/sidebar"
import { AppHeader } from "@/components/shell/header"
import { KillSwitchBanner } from "@/components/shell/kill-switch"
import { fmtPrice } from "@/lib/format"

/** Global toast for WS execution messages: "체결: GME 매수 10주 @ $22.07" */
function ExecutionToasts() {
  useLiveChannel(["execution"], (msg) => {
    if (msg.ch !== "execution") return
    const { symbol, side, qty, price } = msg.data
    toast.info(`체결: ${symbol} ${side === "buy" ? "매수" : "매도"} ${qty}주 @ ${fmtPrice(price)}`)
  })
  return null
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <LiveSocketProvider>
        <div className="flex min-h-dvh">
          <AppSidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <KillSwitchBanner />
            <AppHeader />
            <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
          </div>
        </div>
        <ExecutionToasts />
        <Toaster theme="dark" position="top-right" richColors />
      </LiveSocketProvider>
    </SettingsProvider>
  )
}
