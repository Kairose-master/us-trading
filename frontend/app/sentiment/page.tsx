import { Suspense } from "react"
import { SentimentPageClient } from "@/components/sentiment/sentiment-page-client"
import { Skeleton } from "@/components/primitives"

export const metadata = { title: "센티먼트 — 오토트레이더" }

export default function SentimentPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[480px] w-full" />}>
      <SentimentPageClient />
    </Suspense>
  )
}
