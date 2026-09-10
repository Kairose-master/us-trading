import { HoldingsView } from "@/components/positions/holdings-view"

export const metadata = { title: "미국주식 보유종목 — 오토트레이더" }

export default function PositionsPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold">미국주식 보유종목 — KIS</h1>
      <HoldingsView />
    </div>
  )
}
