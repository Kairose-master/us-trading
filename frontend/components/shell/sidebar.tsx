"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { Bitcoin, Briefcase, Building2, ClipboardList, Cpu, Dna, FlaskConical, Landmark, LayoutDashboard, MessageSquareText, Network, Radar, Settings, ShieldAlert, Sigma, TrendingUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSettings } from "@/components/settings-provider"

type NavItem = { href: string; label: string; icon: typeof Bitcoin; market?: "crypto" | "us" }
type NavGroup = { title: string; icon: typeof Bitcoin; items: NavItem[] }

/**
 * 크립토(Upbit)와 미국주식(KIS)은 계좌도 시간대도 다르다 — 메뉴부터 두 묶음으로 나눈다.
 * 파이프라인·센티먼트는 한 페이지가 두 시장을 다 보여주므로 ?market= 으로 각 묶음에 들어간다.
 */
const GROUPS: NavGroup[] = [
  {
    title: "크립토 · Upbit",
    icon: Bitcoin,
    items: [
      { href: "/crypto", label: "크립토 데스크", icon: LayoutDashboard },
      { href: "/crypto/research", label: "알파 리서치", icon: FlaskConical },
      { href: "/scanner", label: "투자 유니버스", icon: Radar },
      { href: "/office", label: "증권 오피스", icon: Building2 },
      { href: "/evolution", label: "진화 캠페인", icon: Dna },
      { href: "/lab", label: "모델 랩", icon: Cpu },
      { href: "/quant", label: "퀀트 코어", icon: Sigma },
      { href: "/pipeline?market=crypto", label: "파이프라인", icon: Network, market: "crypto" },
      { href: "/sentiment?market=crypto", label: "센티먼트", icon: MessageSquareText, market: "crypto" },
    ],
  },
  {
    title: "미국주식 · KIS",
    icon: Landmark,
    items: [
      { href: "/", label: "대시보드", icon: LayoutDashboard },
      { href: "/positions", label: "보유종목", icon: Briefcase },
      { href: "/orders", label: "주문", icon: ClipboardList },
      { href: "/pipeline?market=us", label: "파이프라인", icon: Network, market: "us" },
      { href: "/sentiment?market=us", label: "센티먼트", icon: MessageSquareText, market: "us" },
    ],
  },
  {
    title: "공통",
    icon: Settings,
    items: [
      { href: "/risk", label: "리스크", icon: ShieldAlert },
      { href: "/settings", label: "설정 · 키 · 거래 모드", icon: Settings },
    ],
  },
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
  const params = useSearchParams()
  const market = params.get("market") ?? "crypto" // 파이프라인·센티먼트 기본은 crypto (페이지 기본값과 동일)
  const isActive = (item: NavItem) => {
    const path = item.href.split("?")[0]
    if (pathname !== path) return false
    return item.market ? market === item.market : true
  }
  return (
    <aside className="flex w-14 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:w-52">
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-3">
        <TrendingUp className="size-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="hidden md:block">
          <p className="text-sm font-bold leading-tight">오토트레이더</p>
          <p className="font-mono text-[9px] leading-tight text-muted-foreground">UPBIT · KIS OPEN API</p>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-3 overflow-y-auto p-2" aria-label="주요 메뉴">
        {GROUPS.map((g) => (
          <div key={g.title} className="flex flex-col gap-0.5">
            <div className="mb-0.5 flex items-center gap-1.5 px-2.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <g.icon className="size-3 md:hidden" aria-hidden="true" />
              <span className="hidden md:inline">{g.title}</span>
            </div>
            {g.items.map((item) => {
              const active = isActive(item)
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="hidden md:inline">{item.label}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="hidden border-t border-sidebar-border md:block">
        <ColorConventionToggle />
      </div>
    </aside>
  )
}
