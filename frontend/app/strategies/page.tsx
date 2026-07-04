import type { Metadata } from "next"
import { StrategiesPageClient } from "@/components/strategies/strategies-page-client"

export const metadata: Metadata = {
  title: "전략 — US 오토트레이더",
}

export default function StrategiesPage() {
  return <StrategiesPageClient />
}
