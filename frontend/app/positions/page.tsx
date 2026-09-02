import { HoldingsView } from "@/components/positions/holdings-view"

export const metadata = { title: "보유종목 — US 오토트레이더" }

export default function PositionsPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold">보유종목</h1>
      <HoldingsView />
    </div>
  )
}
