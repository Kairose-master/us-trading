import { Suspense } from "react"
import { PipelinePageClient } from "@/components/pipeline/pipeline-page-client"
import { Skeleton } from "@/components/primitives"

export const metadata = { title: "파이프라인 — 오토트레이더" }

export default function PipelinePage() {
  return (
    <Suspense fallback={<Skeleton className="h-[640px] w-full" />}>
      <PipelinePageClient />
    </Suspense>
  )
}
