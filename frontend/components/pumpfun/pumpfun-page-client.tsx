"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Copy, Pause, Play, Plus, Radio, RefreshCw, ShieldAlert, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, EmptyState, Skeleton } from "@/components/primitives"
import { ApiError, getPumpfun, getPumpfunEquity, getPumpfunLaunch, getPumpfunWallets, isBackendNotConfigured, pumpfunLaunch, pumpfunLaunchPreview, type PumpLaunchMeta, pumpfunAddWallet, pumpfunFlatten, pumpfunPause, pumpfunReconcile, pumpfunRemoveWallet, pumpfunRescore, pumpfunResume, setPumpfunMode, type PumpLive, type PumpStatus } from "@/lib/api"

/**
 * pump.fun 카피 트레이딩 데스크 — 페이퍼(SOL). 체인이 공개라 "꾸준히 버는 지갑"을 셀 수 있고, 그 지갑의 매수·매도를
 * 몇 초 뒤에 따라간다. 지갑 = 엔진: 실현 결과가 standing(크기)을 움직이고, 굶주린 지갑은 빠진다. 체결은 본딩커브
 * 수식 + 지연 슬리피지 + 우선순위 수수료로 기록된다 — 비용 없는 페이퍼 기록은 자기기만이다.
 *
 * 정직성: PumpPortal API 키(0.02 SOL 충전)가 없으면 거래 스트림이 없어 관측(신규·이주)만 돈다. 그 상태는 배지가 말한다.
 *
 * 실모드(REAL): owner가 "REAL"을 타이핑해 켠다. 같은 카피 규칙이 실장부 위에서 한 번 더 돌고 결과가 PumpPortal Lightning으로
 * 체인에 나간다. 체결 수량·SOL은 트랜잭션에서 읽는다. 포지션 0.1 SOL·총 1 SOL·일 손실 20% 정지·전량 청산 킬스위치.
 * 페이퍼 장부는 그림자로 계속 돌아 실체결과의 차이가 숫자로 남는다.
 */

const sol = (v: number, d = 4) => `${v.toFixed(d)} SOL`
const signed = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}%`
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a)
const t = (s: string) => new Date(s).toLocaleTimeString("ko-KR", { hour12: false })
const ago = (s: string | null) => { if (!s) return "—"; const sec = Math.max(0, Math.round((Date.now() - Date.parse(s)) / 1000)); return sec < 60 ? `${sec}초 전` : sec < 3600 ? `${Math.floor(sec / 60)}분 전` : `${Math.floor(sec / 3600)}시간 전` }

function Stat({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xl font-semibold tnum", valueClass)}>{value}</span>
      {sub && <span className="font-mono text-xs tnum text-muted-foreground">{sub}</span>}
    </Card>
  )
}
const pnlClass = (v: number) => (v > 0 ? "text-chart-1" : v < 0 ? "text-destructive" : "text-muted-foreground")
const scoreClass = (s: number) => (s >= 80 ? "text-chart-1" : s >= 60 ? "" : s >= 40 ? "text-muted-foreground" : "text-destructive")
function CommunityCell({ c }: { c?: { score: number; multiplier: number; unknown: boolean; reasons: string[]; replyCount: number | null; telegramMembers: number | null; isLive: boolean } | null }) {
  if (!c) return <span className="text-muted-foreground">—</span>
  return <span className={cn("font-bold", scoreClass(c.score))} title={c.reasons.join("\n")}>{c.score}{c.unknown ? "?" : ""} <span className="font-normal text-muted-foreground">×{c.multiplier}{c.replyCount !== null ? ` · 💬${c.replyCount}` : ""}{c.telegramMembers !== null ? ` · tg ${c.telegramMembers}` : ""}{c.isLive ? " · LIVE" : ""}</span></span>
}

function FeedBadge({ s }: { s: PumpStatus }) {
  const f = s.feed
  const metered = f.metered.hasKey ? (f.metered.ok === false ? "거래 스트림 거부" : f.metered.ok ? "거래 스트림 ON" : "키 있음") : "관측 전용 (키 없음)"
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] font-semibold", f.connected ? "bg-chart-1/15 text-chart-1" : "bg-destructive/15 text-destructive")} title={f.metered.note ?? undefined}>
      <Radio className="size-3" aria-hidden="true" /> PUMPPORTAL {f.connected ? "LIVE" : "DOWN"} · {metered} · 마지막 메시지 {ago(f.lastMessageAt)}
    </span>
  )
}

function RealModeCard({ live, onChanged }: { live: PumpLive; onChanged: () => Promise<unknown> }) {
  const [arming, setArming] = useState(false)
  const [typed, setTyped] = useState("")
  const [pubkey, setPubkey] = useState(live.walletPubkey ?? "")
  const [busy, setBusy] = useState(false)
  const real = live.mode === "real"
  const go = async (mode: "paper" | "real") => {
    setBusy(true)
    try {
      const r = await setPumpfunMode(mode, mode === "real" ? pubkey.trim() : undefined)
      setArming(false); setTyped("")
      toast[mode === "real" ? "warning" : "success"](mode === "real" ? `실주문 ON — 지갑 ${r.walletSol.toFixed(4)} SOL` : "페이퍼로 전환")
      await onChanged()
    } catch (e) { toast.error(e instanceof ApiError ? e.message : "전환 실패") } finally { setBusy(false) }
  }
  const reconcile = async () => {
    setBusy(true)
    try { const r = await pumpfunReconcile(); toast.success(`체인 대조: 편입 ${r.adopted.length}개, 닫힘 ${r.closed.length}개`); await onChanged() } catch (e) { toast.error(e instanceof ApiError ? e.message : "실패") } finally { setBusy(false) }
  }
  const flatten = async () => {
    if (!confirm("실보유 전량을 시장가로 팔고 정지합니다. 계속?")) return
    setBusy(true)
    try { const r = await pumpfunFlatten(); toast.warning(`전량 청산: ${r.sold}개 매도, ${r.pending}개 미체결`); await onChanged() } catch (e) { toast.error(e instanceof ApiError ? e.message : "실패") } finally { setBusy(false) }
  }
  return (
    <Card className={cn(real && "border-destructive/60")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <ShieldAlert className={cn("size-3.5", real ? "text-destructive" : "text-muted-foreground")} aria-hidden="true" />
        <h2 className="text-sm font-semibold">거래 모드</h2>
        <span className={cn("rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold", real ? "bg-destructive/15 text-destructive" : "bg-chart-1/15 text-chart-1")}>{real ? "REAL — PumpPortal 지갑" : "PAPER — 가상 장부"}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{live.walletPubkey ? `지갑 ${live.walletPubkey.slice(0, 4)}…${live.walletPubkey.slice(-4)} · ${live.walletSol.toFixed(4)} SOL${live.usdc > 0 ? ` + ${live.usdc.toFixed(2)} USDC` : ""} (${ago(live.syncedAt)})` : "지갑 미지정"}</span>
      </div>
      <div className="flex flex-col gap-3 p-4 text-xs">
        {real ? (
          <>
            <div className="grid gap-2 sm:grid-cols-4 font-mono text-[11px]">
              <div><span className="text-muted-foreground">실 에쿼티</span><br />{live.equitySol.toFixed(4)} SOL</div>
              <div><span className="text-muted-foreground">실모드 누적</span><br /><span className={pnlClass(live.returnPct ?? 0)}>{live.returnPct === null ? "—" : signed(live.returnPct)}</span></div>
              <div><span className="text-muted-foreground">오늘</span><br /><span className={pnlClass(live.dayPct)}>{signed(live.dayPct)}</span> (정지 −{live.policy.dailyStopPct}%)</div>
              <div><span className="text-muted-foreground">매수 / 매도 / 실패</span><br />{live.stats.buys} / {live.stats.sells} / {live.stats.failed}</div>
            </div>
            <p className="text-muted-foreground">크기: 실 에쿼티 × {live.policy.maxPositionPct}% × standing (절대 상한 {live.policy.maxPositionSol > 0 ? `${live.policy.maxPositionSol} SOL` : "없음"}) · 총노출 {live.policy.grossMaxPct}% · 로트 {live.policy.maxLots || "무제한"} · 슬리피지 {live.policy.slippagePct}% · 우선순위 수수료 {live.policy.priorityFeeSol} SOL · 지갑 예비 {live.policy.reserveSol} SOL. PumpPortal 거래당 0.5% 추가.</p>
            {live.error && <p className="font-mono text-[11px] text-destructive">최근 오류: {live.error}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void go("paper")} className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50">페이퍼로 돌아가기 (보유는 유지)</button>
              <button type="button" disabled={busy} onClick={() => void reconcile()} className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50">체인 대조 — 지갑 잔고를 장부에 편입</button>
              <button type="button" disabled={busy} onClick={() => void flatten()} className="rounded-md border border-destructive/60 px-2 py-1 text-[11px] text-destructive disabled:opacity-50">킬스위치 — 전량 청산 + 정지</button>
            </div>
          </>
        ) : !arming ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground">실주문은 PumpPortal API 키({live.hasKey ? "있음" : "없음 — PUMPFUN_API_KEY"})와 그 키에 연결된 지갑 공개키가 필요하다. 켜는 순간 지갑 잔고를 조회해 검증한다.</p>
            <button type="button" disabled={!live.hasKey} onClick={() => setArming(true)} className="ml-auto rounded-md border border-destructive/60 px-2 py-1 text-[11px] text-destructive disabled:opacity-50">실주문 켜기…</button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <input value={pubkey} onChange={(e) => setPubkey(e.target.value)} placeholder="PumpPortal 거래 지갑 공개키 (wallet public key)" className="rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[11px]" />
            <div className="flex flex-wrap items-center gap-2">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder='확인을 위해 REAL 입력' className="w-40 rounded-md border border-destructive/60 bg-transparent px-2 py-1 font-mono text-[11px]" />
              <button type="button" disabled={busy || typed !== "REAL" || pubkey.trim().length < 32} onClick={() => void go("real")} className="rounded-md bg-destructive px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50">실주문 ON</button>
              <button type="button" disabled={busy} onClick={() => { setArming(false); setTyped("") }} className="rounded-md border border-border px-2 py-1 text-[11px]">취소</button>
              <span className="text-muted-foreground">이 지갑의 돈이 실제로 나간다. 지갑에는 거래 한도 + 데이터 요금만 넣어 둔다.</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

/** SCAM 발행 카드 — 정직한 버전만. 미리보기는 체인에 아무것도 안 보내고, 발행은 LAUNCH 타이핑 */
function LaunchCard() {
  const { data, mutate } = useSWR("pumpfun-launch", getPumpfunLaunch, { refreshInterval: 60_000, revalidateOnFocus: false })
  const [meta, setMeta] = useState<Partial<PumpLaunchMeta>>({})
  const [devBuy, setDevBuy] = useState(0.01)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  if (!data) return null
  const m = { ...data.defaults, ...meta }
  const field = (k: keyof PumpLaunchMeta, label: string, rows = 1) => (
    <label key={k} className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">{label}
      {rows > 1 ? <textarea value={m[k]} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} rows={rows} className="rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[11px] text-foreground" /> : <input value={m[k]} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} className="rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[11px] text-foreground" />}
    </label>
  )
  const doPreview = async () => { setBusy(true); try { setPreview((await pumpfunLaunchPreview(meta, devBuy)).metadata) } catch (e) { toast.error(e instanceof ApiError ? e.message : "실패") } finally { setBusy(false) } }
  const doLaunch = async () => {
    if (!confirm(`SCAM 을 pump.fun 에 발행합니다. dev buy ${devBuy} SOL. 되돌릴 수 없습니다. 계속?`)) return
    setBusy(true)
    try { const r = await pumpfunLaunch(meta, devBuy); toast.warning(`발행됨: ${r.launched?.mint}`); setTyped(""); await mutate() } catch (e) { toast.error(e instanceof ApiError ? e.message : "발행 실패") } finally { setBusy(false) }
  }
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">SCAM — Smart Contract Attack Museum (우리 코인, 정직한 버전만)</h2><span className="ml-auto font-mono text-[10px] text-muted-foreground">creator 물량 0 · 번들 없음 · 볼륨 조작 없음 · 우리 봇은 이 코인을 사고팔지 않는다 · 수입은 creator 수수료뿐 · 메타데이터 {data.pinata ? "Pinata IPFS" : "대시보드 정적 파일"}</span></div>
      <div className="grid gap-4 p-4 md:grid-cols-[200px_1fr]">
        <div className="flex flex-col gap-2"><img src={data.imageUrl} alt="SCAM" className="w-[200px] rounded-md border border-border" /><a href="https://trust404-prover.vercel.app" target="_blank" rel="noreferrer" className="text-[11px] underline">trust404-prover.vercel.app</a></div>
        {data.launched ? (
          <div className="flex flex-col gap-2 font-mono text-[11px]">
            <p className="text-sm font-semibold">발행됨 {t(data.launched.ts)}</p>
            <p>mint <a href={`https://pump.fun/coin/${data.launched.mint}`} target="_blank" rel="noreferrer" className="underline">{data.launched.mint}</a></p>
            <p>tx <a href={`https://solscan.io/tx/${data.launched.signature}`} target="_blank" rel="noreferrer" className="underline">{data.launched.signature.slice(0, 16)}…</a> · dev buy {data.launched.devBuySol} SOL · by {data.launched.by}</p>
            <p className="text-muted-foreground">홍보는 여기서부터가 사람 몫이다. 우리 봇은 이 mint 를 차단 목록처럼 취급한다.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="grid gap-2 sm:grid-cols-2">{field("name", "이름")}{field("symbol", "심볼")}{field("twitter", "트위터 (선택)")}{field("telegram", "텔레그램 (선택)")}{field("website", "웹사이트")}
              <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">dev buy (SOL, 상한 {data.maxDevBuySol} — 창설 수수료 몫, 물량 목적 아님)<input type="number" step="0.005" min={0} max={data.maxDevBuySol} value={devBuy} onChange={(e) => setDevBuy(Math.min(data.maxDevBuySol, Math.max(0, Number(e.target.value) || 0)))} className="rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[11px] text-foreground" /></label>
            </div>
            {field("description", "설명", 4)}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy} onClick={() => void doPreview()} className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50">미리보기 (체인에 안 보냄)</button>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="확인을 위해 LAUNCH 입력" className="w-44 rounded-md border border-destructive/60 bg-transparent px-2 py-1 font-mono text-[11px]" />
              <button type="button" disabled={busy || typed !== "LAUNCH"} onClick={() => void doLaunch()} className="rounded-md bg-destructive px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50">발행</button>
              <span className="text-[10px] text-muted-foreground">PumpPortal 지갑에서 dev buy + 수수료가 나간다. 되돌릴 수 없다.</span>
            </div>
            {preview && <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[10px]">{JSON.stringify(preview, null, 1)}</pre>}
            {data.attempts.length > 0 && <p className="font-mono text-[10px] text-muted-foreground">시도 {data.attempts.length}회 · 마지막 {data.attempts[data.attempts.length - 1].ok ? "성공" : `실패: ${data.attempts[data.attempts.length - 1].note.slice(0, 80)}`}</p>}
          </div>
        )}
      </div>
    </Card>
  )
}

export function PumpfunPageClient() {
  const { data, error, isLoading, mutate } = useSWR("pumpfun", getPumpfun, { refreshInterval: 5_000, revalidateOnFocus: false })
  const { data: eq } = useSWR("pumpfun-equity", () => getPumpfunEquity(600), { refreshInterval: 60_000, revalidateOnFocus: false })
  const { data: cands, mutate: mutateCands } = useSWR("pumpfun-wallets", () => getPumpfunWallets(30), { refreshInterval: 5 * 60_000, revalidateOnFocus: false })
  const [wallet, setWallet] = useState("")
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast.success(ok); await mutate(); await mutateCands() } catch (e) { toast.error(e instanceof Error ? e.message : "실패") } finally { setBusy(false) }
  }

  if (error && isBackendNotConfigured(error)) return <EmptyState title="백엔드 미연결" hint="BACKEND_URL / BACKEND_TOKEN 이 설정되면 pump.fun 데스크가 보인다." />
  if (isLoading || !data) return <div className="grid gap-4 md:grid-cols-3"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
  if (!data.enabled) return <EmptyState title="pump.fun 데스크 꺼짐" hint="PUMPFUN_ENABLED=true 로 켠다." />

  const L = data.ledger
  const chart = (eq ?? []).map((r) => ({ t: t(r.ts), equity: +r.equitySol.toFixed(4) }))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">pump.fun 카피 트레이딩 — {data.mode === "real" ? "REAL + 페이퍼 그림자" : "페이퍼"} (SOL)</h1>
          <p className="text-xs text-muted-foreground">지갑 = 엔진. 관측한 거래로 지갑을 채점(중앙값 손익·왕복 수·토큰 다양성)해 상위를 추종하고, 실현 결과가 standing(크기)을 움직인다. 페이퍼 체결은 본딩커브 수식 + 지연 슬리피지 {data.costs.latencySlipPct}% + 우선순위 수수료 {data.costs.priorityFeeSol} SOL. 실모드면 같은 규칙이 실장부 위에서 한 번 더 돌고 체결은 체인에서 읽는다.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FeedBadge s={data} />
          {data.paused ? (
            <button type="button" disabled={busy} onClick={() => void run(pumpfunResume, "재개")} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"><Play className="size-3" aria-hidden="true" /> 재개</button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void run(pumpfunPause, "정지 — 신규 진입과 유료 구독 중단, 보유분 청산은 계속")} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"><Pause className="size-3" aria-hidden="true" /> 정지</button>
          )}
          <button type="button" disabled={busy} onClick={() => void run(pumpfunRescore, "지갑 재채점")} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"><RefreshCw className="size-3" aria-hidden="true" /> 재채점</button>
        </div>
      </div>

      {data.paused && <Card className="p-3 text-xs text-destructive">정지됨 — {data.pausedReason} ({data.pausedAt ? t(data.pausedAt) : ""}). 신규 진입 없음, 유료 구독(토큰·지갑 거래 스트림) 중단. 보유 로트의 청산 규칙은 무료 마킹(RPC·시총)으로 계속 돈다.</Card>}
      {!data.feed.metered.hasKey && <Card className="p-3 text-xs text-muted-foreground">관측 전용: PUMPFUN_API_KEY 가 없어 거래 스트림(토큰·지갑)이 없다. 신규 토큰·이주만 기록 중 — 카피는 키(PumpPortal, 0.02 SOL 이상 충전)를 넣어야 시작된다. 수동 시드 지갑도 키 없이는 체결을 볼 수 없다.</Card>}
      {data.feed.metered.hasKey && data.feed.metered.ok === false && <Card className="p-3 text-xs text-destructive">거래 스트림 거부: {data.feed.metered.note}</Card>}

      <RealModeCard live={data.live} onChanged={() => mutate()} />
      <LaunchCard />

      {data.mode === "real" && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="border-destructive/40">
            <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">실보유 로트 (체인)</h2><span className="ml-auto font-mono text-[10px] text-muted-foreground">진행 중 {data.live.inflight.length}</span></div>
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[11px]">
                <thead><tr className="border-b border-border bg-muted/40 text-left text-muted-foreground"><th className="px-3 py-1.5 font-medium">토큰</th><th className="px-3 py-1.5 font-medium">via</th><th className="px-3 py-1.5 font-medium">풀</th><th className="px-3 py-1.5 font-medium">비용</th><th className="px-3 py-1.5 font-medium">평가</th><th className="px-3 py-1.5 font-medium">손익</th><th className="px-3 py-1.5 font-medium">보유</th><th className="px-3 py-1.5 font-medium">커뮤니티</th></tr></thead>
                <tbody className="divide-y divide-border/50">
                  {data.live.lots.map((l) => (
                    <tr key={l.id}><td className="px-3 py-1" title={l.mint}>{short(l.mint)}</td><td className="px-3 py-1 text-muted-foreground" title={l.via}>{short(l.via)}</td><td className="px-3 py-1">{l.pool}</td><td className="px-3 py-1">{l.costSol.toFixed(4)}</td><td className="px-3 py-1">{l.markSol.toFixed(4)} <span className="text-muted-foreground">{ago(l.markAt)}</span></td><td className={cn("px-3 py-1 font-bold", pnlClass(l.pnlPct))}>{signed(l.pnlPct)}</td><td className="px-3 py-1">{l.holdMin.toFixed(0)}분</td><td className="px-3 py-1"><CommunityCell c={l.community} /></td></tr>
                  ))}
                  {data.live.lots.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">실보유 없음</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
          <Card className="border-destructive/40">
            <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">실체결 (트랜잭션에서 읽은 값)</h2></div>
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[11px]">
                <thead><tr className="border-b border-border bg-muted/40 text-left text-muted-foreground"><th className="px-3 py-1.5 font-medium">시각</th><th className="px-3 py-1.5 font-medium">방향</th><th className="px-3 py-1.5 font-medium">토큰</th><th className="px-3 py-1.5 font-medium">SOL</th><th className="px-3 py-1.5 font-medium">손익</th><th className="px-3 py-1.5 font-medium">서명</th><th className="px-3 py-1.5 font-medium">사유</th></tr></thead>
                <tbody className="divide-y divide-border/50">
                  {data.live.orders.map((o) => (
                    <tr key={o.id}><td className="px-3 py-1 text-muted-foreground">{t(o.ts)}</td><td className={cn("px-3 py-1 font-bold", o.side === "buy" ? "text-chart-1" : "text-destructive")}>{o.side === "buy" ? "매수" : "매도"}</td><td className="px-3 py-1" title={o.mint}>{short(o.mint)}</td><td className="px-3 py-1">{o.sol.toFixed(4)}</td><td className={cn("px-3 py-1", o.pnlPct === undefined ? "text-muted-foreground" : pnlClass(o.pnlPct))}>{o.pnlPct === undefined ? "—" : `${signed(o.pnlPct)} (${o.pnlSol?.toFixed(4)})`}</td><td className="px-3 py-1">{o.signature ? <a href={`https://solscan.io/tx/${o.signature}`} target="_blank" rel="noreferrer" className="underline">{o.signature.slice(0, 8)}…</a> : "—"}</td><td className="max-w-[200px] truncate px-3 py-1 text-muted-foreground" title={o.reason}>{o.reason}</td></tr>
                  ))}
                  {data.live.orders.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">실체결 없음</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {data.mode === "real" ? (
          <>
            <Stat label="실 에쿼티 (지갑)" value={sol(data.live.equitySol)} valueClass="text-destructive" sub={`시작 ${data.live.startSol === null ? "—" : sol(data.live.startSol, 3)} · 페이퍼 그림자 ${sol(L.equitySol, 2)} (가상 시드 ${L.startSol})`} />
            <Stat label="실 누적 수익률" value={data.live.returnPct === null ? "—" : signed(data.live.returnPct)} valueClass={pnlClass(data.live.returnPct ?? 0)} sub={`오늘 ${signed(data.live.dayPct)} (일 손실 정지 −${data.live.policy.dailyStopPct}%) · 페이퍼 ${signed(L.returnPct)}`} />
            <Stat label="지갑 SOL / 실포지션" value={sol(data.live.walletSol, 4)} sub={`${data.live.usdc > 0 ? `+ ${data.live.usdc.toFixed(2)} USDC (≈${sol(data.live.usdcInSol, 3)}) · ` : ""}포지션 ${sol(data.live.positionsSol, 4)} · 로트 ${data.live.lots.length}${data.live.policy.maxLots ? `/${data.live.policy.maxLots}` : ""} · 동기화 ${ago(data.live.syncedAt)}`} />
          </>
        ) : (
          <>
            <Stat label="에쿼티 (페이퍼)" value={sol(L.equitySol)} sub={`가상 시드 ${sol(L.startSol, 2)} · ${ago(L.since)}부터`} />
            <Stat label="누적 수익률" value={signed(L.returnPct)} valueClass={pnlClass(L.returnPct)} sub={`오늘 ${signed(L.dayPct)} (일 손실 정지 −${data.policy.dailyStopPct}%)`} />
            <Stat label="현금 / 포지션" value={sol(L.cashSol, 3)} sub={`포지션 ${sol(L.positionsSol, 3)} · 로트 ${L.lots.length}${data.policy.maxLots ? `/${data.policy.maxLots}` : ""}`} />
          </>
        )}
        <Stat label="추종 지갑" value={`${data.follows.length}`} valueClass={data.follows.length === 0 ? "text-destructive" : undefined} sub={data.follows.length === 0 ? "0개 — 따라갈 지갑이 없어 주문이 안 나간다. 시드를 넣거나 채점을 기다린다" : `상한 ${data.policy.followMax} · 시드 ${data.seeds.length} · 채점 대상 ${data.tradeBuffer.wallets ?? "—"} (자격 ${data.tradeBuffer.eligible ?? "—"} · 잠정 ${data.tradeBuffer.provisional ?? "—"})`} />
        <Stat label="카피 / 청산" value={`${data.stats.copies} / ${data.stats.exits}`} sub={`관측 거래 ${data.stats.tradesObserved.toLocaleString()} · 발견 창 ${data.discovery.length}`} />
        <Stat label="오늘 유료 메시지 (비용)" value={`${data.feed.metered.todayMsgs.toLocaleString()} (${data.feed.metered.todaySol.toFixed(4)} SOL)`} valueClass={data.budget.overBudget ? "text-destructive" : undefined} sub={`예산 ${data.budget.msgsPerDay.toLocaleString()}건/일 = ${data.budget.solPerDay} SOL${data.budget.overBudget ? " · 초과 — 발견 창 닫힘" : ""} · 누적 ${data.feed.metered.totalSol.toFixed(3)} SOL · 신규 ${data.stats.creates.toLocaleString()} / 이주 ${data.stats.migrations}`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">에쿼티 (SOL, 5분 스냅샷)</h2><span className="ml-auto font-mono text-[10px] text-muted-foreground">평가액 = 지금 전부 팔면 받는 SOL (한계가×수량이 아니다)</span></div>
          <div className="h-56 p-2">
            {chart.length < 2 ? <EmptyState title="스냅샷 대기" hint="5분마다 한 줄. 재시작을 견딘다." /> : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10 }} width={56} />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="equity" stroke="var(--chart-1)" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">정책</h2><span className="ml-auto font-mono text-[10px] text-muted-foreground">POST /pumpfun/policy</span></div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 p-4 font-mono text-[11px]">
            {([["포지션 상한", `${data.policy.maxPositionSol} SOL`], ["1회 위험", `${data.policy.riskPct}% × standing`], ["총노출 / 현금 하한", `${data.policy.grossMaxPct}% / ${data.policy.cashFloorPct}%`], ["리더 최소 매수", `${data.policy.minLeaderSol} SOL`], ["손절", `−${data.policy.stopLossPct}% (러그 감시가 먼저)`], ["익절 사다리", data.policy.ladder.map((r) => `+${r.atPct}%에 ${Math.round(r.fraction * 100)}%`).join(" · ") + " · 나머지는 달린다"], ["되돌림", `+${data.policy.trailingActivatePct}% 넘긴 뒤에만 고점 대비 −${data.policy.trailingPct}%`], ["시간 정지", `${data.policy.maxHoldMin}분 — 이익 +${data.policy.timeStopExemptPct}% 미만인 로트만`], ["추종 해제", `${data.policy.dropAfterCloses}회 뒤 누적 ${data.policy.dropAtPct}%`], ["발견 창", `이주 후 ${data.policy.discoveryWindowMin}분 × ${data.policy.discoveryMaxMints}개`], ["유료 예산", `${data.policy.meteredBudgetMsgsPerDay.toLocaleString()}건/일 · 보유 토큰 구독 ${data.policy.subscribeHeldTokens ? "ON" : "OFF (RPC 폴링)"}`], ["러그 감시", `${data.policy.crashWindowSec}초 안 −${data.policy.crashPct}% 즉시 전량 · 개발자 매도 즉시 전량 · creator 보유 ≥10% / 창설 매수 ≥5 SOL 차단 · 보안 판정 변경 청산`], ["플립 방지", `리더가 10분에 ${data.policy.maxLeaderFlips10m}회 이상 왕복한 토큰 안 삼 · 리더 최근 보유 < ${data.policy.minLeaderHoldMin}분이면 안 삼 · 청산 후 ${data.policy.reentryCooldownMin}분 재진입 금지`], ["보호 종목", `${data.protectedMints.length}개 — 봇이 사고팔지도 편입하지도 않음 (SCAM 등 수동 보유)`], ["커뮤니티 게이트", `${data.community.policy.gate ? `점수 < ${data.community.policy.minScore} 거름` : "OFF"} · 40~59 ×0.5 · 60~79 ×1 · ≥80 ×1.25 · 읽음 ${data.community.stats.reads} / 거름 ${data.community.stats.blocked}`], ["재채점", `${data.policy.rescoreMin}분`], ["자격", `왕복 ≥${data.thresholds.minRoundTrips} · 토큰 ≥${data.thresholds.minMints} · 중앙값 >${data.thresholds.minMedianPnlPct}% · 승률 ≥${data.thresholds.minWinRate}`]] as Array<[string, string]>).map(([k, v]) => (<div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>))}
          </dl>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><Copy className="size-3.5 text-muted-foreground" aria-hidden="true" /><h2 className="text-sm font-semibold">추종 지갑 (standing = 실현수익으로 움직이는 크기)</h2></div>
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Solana 지갑 주소 — 항상 추종할 시드" className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[11px]" />
            <button type="button" disabled={busy || !wallet.trim()} onClick={() => void run(async () => { await pumpfunAddWallet(wallet.trim()); setWallet("") }, "시드 추가")} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"><Plus className="size-3" aria-hidden="true" /> 추가</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[11px]">
              <thead><tr className="border-b border-border bg-muted/40 text-left text-muted-foreground"><th className="px-3 py-1.5 font-medium">지갑</th><th className="px-3 py-1.5 font-medium">standing</th><th className="px-3 py-1.5 font-medium">출처</th><th className="px-3 py-1.5 font-medium">청산 / 적중</th><th className="px-3 py-1.5 font-medium">누적</th><th className="px-3 py-1.5 font-medium">보유</th><th className="px-3 py-1.5 font-medium"></th></tr></thead>
              <tbody className="divide-y divide-border/50">
                {data.follows.map((f) => (
                  <tr key={f.wallet}>
                    <td className="px-3 py-1" title={f.wallet}>{short(f.wallet)}</td>
                    <td className="px-3 py-1 font-bold">{f.standing.toFixed(2)}</td>
                    <td className="px-3 py-1 text-muted-foreground">{f.source === "manual" ? "시드" : "채점"}</td>
                    <td className="px-3 py-1">{f.closes} / {f.hitRate === null ? "—" : `${Math.round(f.hitRate * 100)}%`}</td>
                    <td className={cn("px-3 py-1", pnlClass(f.cumPct))}>{signed(f.cumPct)}</td>
                    <td className="px-3 py-1">{f.openLots}</td>
                    <td className="px-3 py-1 text-right"><button type="button" disabled={busy} onClick={() => void run(() => pumpfunRemoveWallet(f.wallet), "추종 해제")} className="text-muted-foreground hover:text-destructive" aria-label="추종 해제"><Trash2 className="size-3" /></button></td>
                  </tr>
                ))}
                {data.follows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">추종 지갑 없음 — 재채점이 자격 지갑을 찾거나, 시드를 넣는다.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">채점 후보 (최근 {data.tradeBuffer.hours}h 관측 거래 {cands?.trades.toLocaleString() ?? "—"}건)</h2><span className="ml-auto font-mono text-[10px] text-muted-foreground">score = 중앙값% × √왕복 × 승률</span></div>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[11px]">
              <thead><tr className="border-b border-border bg-muted/40 text-left text-muted-foreground"><th className="px-3 py-1.5 font-medium">지갑</th><th className="px-3 py-1.5 font-medium">score</th><th className="px-3 py-1.5 font-medium">왕복</th><th className="px-3 py-1.5 font-medium">토큰</th><th className="px-3 py-1.5 font-medium">중앙값</th><th className="px-3 py-1.5 font-medium">승률</th><th className="px-3 py-1.5 font-medium">총 손익</th><th className="px-3 py-1.5 font-medium">보유(중앙)</th></tr></thead>
              <tbody className="divide-y divide-border/50">
                {(cands?.ranked ?? []).slice(0, 15).map((w) => {
                  const ok = cands?.eligible.some((e) => e.wallet === w.wallet)
                  const prov = cands?.provisional.some((e) => e.wallet === w.wallet)
                  return (
                    <tr key={w.wallet} className={cn(ok && "bg-chart-1/5", prov && "bg-chart-2/5")} title={ok ? "정식 자격" : prov ? "잠정 자격 (standing 0.25로 시작)" : undefined}>
                      <td className="px-3 py-1" title={w.wallet}>{short(w.wallet)}</td>
                      <td className={cn("px-3 py-1 font-bold", w.score > 0 ? "text-chart-1" : "text-muted-foreground")}>{w.score}</td>
                      <td className="px-3 py-1">{w.roundTrips}</td><td className="px-3 py-1">{w.mints}</td>
                      <td className={cn("px-3 py-1", pnlClass(w.medianPnlPct))}>{signed(w.medianPnlPct)}</td>
                      <td className="px-3 py-1">{Math.round(w.winRate * 100)}%</td>
                      <td className={cn("px-3 py-1", pnlClass(w.totalPnlSol))}>{w.totalPnlSol.toFixed(3)}</td>
                      <td className="px-3 py-1 text-muted-foreground">{w.medianHoldMin}분</td>
                    </tr>
                  )
                })}
                {(cands?.ranked.length ?? 0) === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">채점할 거래가 없다 — 거래 스트림(API 키)이 있어야 지갑이 보인다.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">보유 로트</h2><span className="ml-auto font-mono text-[10px] text-muted-foreground">마킹 = 스트림 체결의 준비금, 끊기면 RPC로 커브 계정</span></div>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[11px]">
              <thead><tr className="border-b border-border bg-muted/40 text-left text-muted-foreground"><th className="px-3 py-1.5 font-medium">토큰</th><th className="px-3 py-1.5 font-medium">via</th><th className="px-3 py-1.5 font-medium">풀</th><th className="px-3 py-1.5 font-medium">비용</th><th className="px-3 py-1.5 font-medium">평가</th><th className="px-3 py-1.5 font-medium">손익</th><th className="px-3 py-1.5 font-medium">보유</th><th className="px-3 py-1.5 font-medium">커브</th><th className="px-3 py-1.5 font-medium">커뮤니티</th></tr></thead>
              <tbody className="divide-y divide-border/50">
                {L.lots.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-1" title={l.mint}>{short(l.mint)}</td>
                    <td className="px-3 py-1 text-muted-foreground" title={l.via}>{short(l.via)}</td>
                    <td className="px-3 py-1">{l.pool}</td>
                    <td className="px-3 py-1">{l.costSol.toFixed(4)}</td>
                    <td className="px-3 py-1">{l.markSol.toFixed(4)} <span className="text-muted-foreground">{ago(l.markAt)}</span></td>
                    <td className={cn("px-3 py-1 font-bold", pnlClass(l.pnlPct))}>{signed(l.pnlPct)}</td>
                    <td className="px-3 py-1">{l.holdMin.toFixed(0)}분 / {data.policy.maxHoldMin}</td>
                    <td className="px-3 py-1 text-muted-foreground">{l.progress === null ? "—" : `${Math.round(l.progress * 100)}%`}</td>
                    <td className="px-3 py-1"><CommunityCell c={l.community} /></td>
                  </tr>
                ))}
                {L.lots.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">보유 없음 — 100% 현금이 정식 답이다.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">최근 체결 (페이퍼)</h2></div>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[11px]">
              <thead><tr className="border-b border-border bg-muted/40 text-left text-muted-foreground"><th className="px-3 py-1.5 font-medium">시각</th><th className="px-3 py-1.5 font-medium">방향</th><th className="px-3 py-1.5 font-medium">토큰</th><th className="px-3 py-1.5 font-medium">SOL</th><th className="px-3 py-1.5 font-medium">임팩트</th><th className="px-3 py-1.5 font-medium">손익</th><th className="px-3 py-1.5 font-medium">사유</th></tr></thead>
              <tbody className="divide-y divide-border/50">
                {data.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="px-3 py-1 text-muted-foreground">{t(o.ts)}</td>
                    <td className={cn("px-3 py-1 font-bold", o.side === "buy" ? "text-chart-1" : "text-destructive")}>{o.side === "buy" ? "매수" : "매도"}</td>
                    <td className="px-3 py-1" title={o.mint}>{short(o.mint)}</td>
                    <td className="px-3 py-1">{o.sol.toFixed(4)}</td>
                    <td className="px-3 py-1 text-muted-foreground">{o.impactPct.toFixed(2)}%</td>
                    <td className={cn("px-3 py-1", o.pnlPct === undefined ? "text-muted-foreground" : pnlClass(o.pnlPct))}>{o.pnlPct === undefined ? "—" : `${signed(o.pnlPct)} (${o.pnlSol?.toFixed(4)})`}</td>
                    <td className="max-w-[220px] truncate px-3 py-1 text-muted-foreground" title={o.reason}>{o.reason}</td>
                  </tr>
                ))}
                {data.orders.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">체결 없음</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">복합 결정 — 흐름 · 모멘텀 · 카피 표 · 커뮤니티</h2>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">가중치 flow {data.ensemble.weights.flow} · momentum {data.ensemble.weights.momentum} · copy {data.ensemble.weights.copy} · community {data.ensemble.weights.community} (실현 결과로 움직임) · 진입 ≥{data.ensemble.policy.enterScore} · 청산 &lt;{data.ensemble.policy.exitScore} · 기본 크기 {data.ensemble.policy.basePct}% · 직접 카피 {data.ensemble.directCopy ? "ON" : "OFF"} · 스트림 후보 {data.ensemble.flowMaxMints}개 · 스크린 후보 {data.ensemble.screen.candidates} ({ago(data.ensemble.screen.lastPollAt)}) · 진입 {data.ensemble.stats.entries} / 청산 {data.ensemble.stats.exits}</span>
          <span className="w-full font-mono text-[10px]" style={{color: data.ensemble.conviction.mode ? "var(--chart-1)" : "var(--muted-foreground, #888)"}}>확신 집중: {data.ensemble.conviction.mode ? `ON — 점수 ≥${data.ensemble.conviction.minScore} 최상위 ${data.ensemble.conviction.maxLots}개에만 에쿼티 ${data.ensemble.conviction.pct}% 몰빵 (열림 ${data.ensemble.conviction.open}) · 러그 가드 유지` : "OFF (자격 후보 분산, 각 basePct)"}</span>
          <span className="w-full font-mono text-[10px] text-muted-foreground">탄력 구독: 분당 {data.ensemble.elastic.msgsPerMin} / 페이스 {data.ensemble.elastic.pacePerMin} → 활성 후보 {data.ensemble.elastic.activeFlowMax}/{data.ensemble.flowMaxMints}개 · 폭주 차단 {data.ensemble.elastic.floodBlocked} (분당 ≥{data.policy.floodMintPerMin} 컷){data.ensemble.elastic.topMintRates.length ? " · 상위 " + data.ensemble.elastic.topMintRates.map((r) => `${r.mint.slice(0,4)} ${r.perMin}/m`).join(" · ") : ""}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px]">
            <thead><tr className="border-b border-border bg-muted/40 text-left text-muted-foreground"><th className="px-3 py-1.5 font-medium">토큰</th><th className="px-3 py-1.5 font-medium">합성</th><th className="px-3 py-1.5 font-medium">결정</th><th className="px-3 py-1.5 font-medium">flow</th><th className="px-3 py-1.5 font-medium">momentum</th><th className="px-3 py-1.5 font-medium">copy</th><th className="px-3 py-1.5 font-medium">community</th><th className="px-3 py-1.5 font-medium">스트림</th><th className="px-3 py-1.5 font-medium">근거</th></tr></thead>
            <tbody className="divide-y divide-border/50">
              {data.ensemble.candidates.map((c) => {
                const v = (e: string) => c.votes.find((x) => x.engine === e)
                const cell = (e: string) => { const x = v(e); return x ? <span className={cn(x.abstain ? "text-muted-foreground" : scoreClass(x.score))} title={x.why.join("\n")}>{x.abstain ? "기권" : x.score}</span> : "—" }
                return (
                  <tr key={c.mint} className={cn(c.held > 0 && "bg-chart-1/5", c.action === "enter" && "bg-chart-2/10")}>
                    <td className="px-3 py-1" title={c.mint}>{c.symbol ?? short(c.mint)}{c.held > 0 ? " ·보유" : ""}</td>
                    <td className={cn("px-3 py-1 font-bold", scoreClass(c.score))}>{c.score}</td>
                    <td className="px-3 py-1">{c.blocked ? "차단" : c.action === "enter" ? "진입" : c.action === "exit" ? "청산" : c.action === "hold" ? "보유" : "—"}{c.action === "enter" ? ` ×${c.sizeMult}` : ""}</td>
                    <td className="px-3 py-1">{cell("flow")}</td><td className="px-3 py-1">{cell("momentum")}</td><td className="px-3 py-1">{cell("copy")}</td><td className="px-3 py-1">{cell("community")}</td>
                    <td className="px-3 py-1 text-muted-foreground">{c.streamed ? "유료" : "무료"}</td>
                    <td className="max-w-[360px] truncate px-3 py-1 text-muted-foreground" title={c.why}>{c.why}</td>
                  </tr>
                )
              })}
              {data.ensemble.candidates.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">후보 없음 — 스크린이 30초마다 pump.fun 을 폴링한다</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">커뮤니티 읽기 — 밈코인은 커뮤니티가 가격이다</h2><span className="ml-auto font-mono text-[10px] text-muted-foreground">pump.fun 댓글·KOTH·라이브·소셜 링크 · 텔레그램 구독자 · creator 48h 발행 수 · 보안 판정 · ATH 대비 · (RPC 있으면) 상위10 홀더</span></div>
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px]">
            <thead><tr className="border-b border-border bg-muted/40 text-left text-muted-foreground"><th className="px-3 py-1.5 font-medium">시각</th><th className="px-3 py-1.5 font-medium">토큰</th><th className="px-3 py-1.5 font-medium">점수</th><th className="px-3 py-1.5 font-medium">배수</th><th className="px-3 py-1.5 font-medium">근거</th></tr></thead>
            <tbody className="divide-y divide-border/50">
              {data.community.recent.map((r) => (
                <tr key={r.mint + r.at} className={cn(r.block && "opacity-60")}>
                  <td className="px-3 py-1 text-muted-foreground">{t(r.at)}</td>
                  <td className="px-3 py-1" title={r.mint}>{r.symbol ?? short(r.mint)}</td>
                  <td className={cn("px-3 py-1 font-bold", scoreClass(r.score))}>{r.score}{r.unknown ? "?" : ""}</td>
                  <td className="px-3 py-1">{r.block ? "거름" : `×${r.multiplier}`}</td>
                  <td className="max-w-[520px] truncate px-3 py-1 text-muted-foreground" title={r.reasons.join("\n")}>{r.reasons.join(" · ")}</td>
                </tr>
              ))}
              {data.community.recent.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">아직 읽은 토큰 없음 — 추종 지갑이 사는 순간 읽는다</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">신규 토큰 (무료 스트림)</h2><span className="ml-auto font-mono text-[10px] text-muted-foreground">관측 기록 data/pumpfun/events-YYYY-MM-DD.jsonl</span></div>
          <ul className="divide-y divide-border/50 font-mono text-[11px]">
            {data.recentCreates.slice(0, 12).map((c) => (
              <li key={c.mint} className="flex items-center gap-3 px-4 py-1.5"><span className="text-muted-foreground">{t(c.ts)}</span><span className="font-bold">{c.symbol || "?"}</span><span className="truncate text-muted-foreground">{c.name}</span><span className="ml-auto">{c.initialBuySol.toFixed(2)} SOL 초기매수 · mcap {c.marketCapSol.toFixed(1)}</span></li>
            ))}
            {data.recentCreates.length === 0 && <li className="px-4 py-6 text-center text-muted-foreground">대기 중</li>}
          </ul>
        </Card>
        <Card>
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">졸업 (커브 → PumpSwap 이주)</h2><span className="ml-auto font-mono text-[10px] text-muted-foreground">키가 있으면 이주 토큰의 거래를 {data.policy.discoveryWindowMin}분 관측해 지갑을 발견한다</span></div>
          <ul className="divide-y divide-border/50 font-mono text-[11px]">
            {data.recentMigrations.slice(0, 12).map((m) => (
              <li key={m.mint + m.ts} className="flex items-center gap-3 px-4 py-1.5"><span className="text-muted-foreground">{t(m.ts)}</span><span title={m.mint}>{short(m.mint)}</span><span className="ml-auto text-muted-foreground">{m.pool || "pump-amm"}</span></li>
            ))}
            {data.recentMigrations.length === 0 && <li className="px-4 py-6 text-center text-muted-foreground">대기 중 — 졸업은 하루 수십 건이다</li>}
          </ul>
        </Card>
      </div>
      {data.lastError && <p className="font-mono text-[10px] text-muted-foreground">last error: {data.lastError}</p>}
    </div>
  )
}
