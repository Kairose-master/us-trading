"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Activity, Bitcoin, Briefcase, ClipboardList, Cpu, LayoutDashboard, MessageSquareText, Network, ShieldAlert, Sigma, TrendingUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSettings } from "@/components/settings-provider"

const NAV = [
  { href: "/", label: "대시보드", icon: LayoutDashboard },
  { href: "/positions", label: "보유종목", icon: Briefcase },
  { href: "/orders", label: "주문", icon: ClipboardList },
  { href: "/strategies", label: "전략", icon: Activity },
  { href: "/pipeline", label: "파이프라인", icon: Network },
  { href: "/sentiment", label: "센티먼트", icon: MessageSquareText },
  { href: "/crypto", label: "크립토", icon: Bitcoin },
  { href: "/lab", label: "모델 랩", icon: Cpu },
  { href: "/quant", label: "퀀트 코어", icon: Sigma },
  { href: "/risk", label: "리스크", icon: ShieldAlert },
]

function ColorConventionToggle() {
  const { krColors, setKrColors } = useSettings()
  return (
    <div className="flex flex-col gap-1.5 px-3 py-3">
      <span className="text-[10px] font-medium text-muted-foreground">색상</span>
      <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-0.5" role="radiogroup" aria-label="상승/하락 색상 방식">
        <button
          type="button"
          role="radio"
          aria-checked={!krColors}
          onClick={() => setKrColors(false)}
          className={cn(
            "rounded px-1.5 py-1 text-[10px] font-medium transition-colors",
            !krColors ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          미국식
          <span className="block text-[9px] text-muted-foreground">상승 초록</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={krColors}
          onClick={() => setKrColors(true)}
          className={cn(
            "rounded px-1.5 py-1 text-[10px] font-medium transition-colors",
            krColors ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          한국식
          <span className="block text-[9px] text-muted-foreground">상승 빨강</span>
        </button>
      </div>
    </div>
  )
}

export function AppSidebar() {
  const pathname = usePathname()
  return (
    <aside className="flex w-14 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:w-48">
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-3">
        <TrendingUp className="size-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="hidden md:block">
          <p className="text-sm font-bold leading-tight">US 오토트레이더</p>
          <p className="font-mono text-[9px] leading-tight text-muted-foreground">KIS OPEN API</p>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 p-2" aria-label="주요 메뉴">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="hidden md:inline">{label}</span>
            </Link>
          )
        })}
      </nav>
      <div className="hidden border-t border-sidebar-border md:block">
        <ColorConventionToggle />
      </div>
    </aside>
  )
}
