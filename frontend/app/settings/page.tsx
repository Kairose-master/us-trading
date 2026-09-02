import { SettingsClient } from "@/components/settings/settings-client"

export const metadata = { title: "설정 — US 오토트레이더" }

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold">설정 — 계정 · 거래소 키</h1>
      <SettingsClient />
    </div>
  )
}
