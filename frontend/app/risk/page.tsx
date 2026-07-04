import type { Metadata } from "next"
import { RiskPageClient } from "@/components/risk/risk-page-client"

export const metadata: Metadata = {
  title: "리스크 관리 — US 오토트레이더",
}

export default function RiskPage() {
  return <RiskPageClient />
}
