import { logger } from "../core/logger.js";

/**
 * 러그 스크린 — 진입 직전, 그 토큰의 **생성부터 지금까지의 전체 거래**(pump.fun swap-api v2, 키 없음·무료)로
 * 물량 구조를 재구성해 러그 위험을 판정한다. 기준값은 실측 분석(docs/pumpfun.md "러그 실측", backend/scripts/pumpfun_rug_*.py)에서 왔다.
 *
 *   GET https://swap-api.pump.fun/v2/coins/{mint}/trades?limit=100[&cursor=…]  → { trades: [{ timestamp, userAddress, type, amountSol, baseAmount, priceSol, … }], pagination: { nextCursor, hasMore } }
 *   최신순 · 페이지당 100 · 빠르게 부르면 429 (실측) → 전역 350ms 간격.
 *
 * 한계: 지갑 간 토큰 전송은 거래가 아니라 안 보인다(개발자가 다른 지갑으로 옮겨 팔면 "개발자 보유"로 남는다).
 * 그래서 번들·상위 홀더·단일 대량 매도처럼 전송으로 숨기기 어려운 신호를 함께 본다.
 */

export const SUPPLY = 1_000_000_000;
export interface RugTrade { ts: number; wallet: string; side: 1 | -1; sol: number; tokens: number; price: number }

export interface RugFeatures {
  /** 기록이 생성 시점까지 닿았나 — 아니면 보유 구조 지표는 믿을 수 없다 */
  complete: boolean;
  nTrades: number;
  ageMin: number;
  creatorPct: number | null;
  /** 개발자가 산 물량 중 이미 판 비율 0~1 */
  creatorSoldFrac: number;
  top1Pct: number;
  top10Pct: number;
  holders: number;
  /** 첫 거래 3초 안에 산 지갑들(번들·스나이퍼)이 아직 쥔 공급 % */
  bundle3sPct: number;
  snipers60Pct: number;
  uniqBuyers5m: number;
  tradesPerWallet5m: number;
  top3BuyShare5m: number;
}

/** 거래(오름차순) → 진입 시점 특징. 분석 스크립트(features)와 같은 정의 */
export function rugFeatures(trades: RugTrade[], creator: string | null, createdMs: number, nowMs: number, complete: boolean): RugFeatures {
  const net = new Map<string, number>(); const bought = new Map<string, number>(); const sold = new Map<string, number>(); const firstBuy = new Map<string, number>();
  for (const x of trades) {
    net.set(x.wallet, (net.get(x.wallet) ?? 0) + x.side * x.tokens);
    if (x.side > 0) { bought.set(x.wallet, (bought.get(x.wallet) ?? 0) + x.tokens); if (!firstBuy.has(x.wallet)) firstBuy.set(x.wallet, x.ts); }
    else sold.set(x.wallet, (sold.get(x.wallet) ?? 0) + x.tokens);
  }
  const pos = [...net.entries()].filter(([, v]) => v > 0);
  const tops = pos.map(([, v]) => v).sort((a, b) => b - a);
  const first = trades.length ? trades[0].ts : createdMs;
  const heldBy = (ws: Iterable<string>) => { let s = 0; for (const w of ws) s += Math.max(0, net.get(w) ?? 0); return (s / SUPPLY) * 100; };
  const early = (ms: number) => [...firstBuy.entries()].filter(([, ts]) => ts - first <= ms).map(([w]) => w);
  const rec = trades.filter((x) => x.ts >= nowMs - 5 * 60_000);
  const buySol = new Map<string, number>();
  for (const x of rec) if (x.side > 0) buySol.set(x.wallet, (buySol.get(x.wallet) ?? 0) + x.sol);
  const bs = [...buySol.values()].sort((a, b) => b - a); const totB = bs.reduce((a, b) => a + b, 0) || 1e-9;
  return {
    complete, nTrades: trades.length, ageMin: (nowMs - createdMs) / 60_000,
    creatorPct: creator ? (Math.max(0, net.get(creator) ?? 0) / SUPPLY) * 100 : null,
    creatorSoldFrac: creator && (bought.get(creator) ?? 0) > 0 ? (sold.get(creator) ?? 0) / bought.get(creator)! : 0,
    top1Pct: tops.length ? (tops[0] / SUPPLY) * 100 : 0,
    top10Pct: (tops.slice(0, 10).reduce((a, b) => a + b, 0) / SUPPLY) * 100,
    holders: pos.filter(([, v]) => v / SUPPLY >= 1e-4).length,
    bundle3sPct: heldBy(early(3_000)),
    snipers60Pct: heldBy(early(60_000)),
    uniqBuyers5m: buySol.size,
    tradesPerWallet5m: rec.length / Math.max(1, new Set(rec.map((x) => x.wallet)).size),
    top3BuyShare5m: bs.slice(0, 3).reduce((a, b) => a + b, 0) / totB,
  };
}

// ===== 가져오기 (무료 API, 전역 간격) =====
const TRADES_URL = (mint: string, cursor?: string) => `https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
let lastCallAt = 0;
async function slot() { const wait = lastCallAt + 350 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastCallAt = Date.now(); }
interface RawTrade { timestamp: string; userAddress: string; type: string; amountSol?: string; baseAmount?: string; priceSol?: string }

/** 생성 시점까지 거꾸로 페이지를 넘긴다(최대 maxPages). 오름차순으로 돌려준다 */
export async function fetchTradesFromCreation(mint: string, createdMs: number, maxPages = 15, timeoutMs = 6_000): Promise<{ trades: RugTrade[]; complete: boolean }> {
  const out: RugTrade[] = []; let cursor: string | undefined; let complete = false;
  for (let page = 0; page < maxPages; page++) {
    await slot();
    let res = await fetch(TRADES_URL(mint, cursor), { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1_500)); await slot(); res = await fetch(TRADES_URL(mint, cursor), { signal: AbortSignal.timeout(timeoutMs) }); }
    if (!res.ok) throw new Error(`trades ${res.status}`);
    const j = (await res.json()) as { trades?: RawTrade[]; pagination?: { nextCursor?: string; hasMore?: boolean } };
    const rows = j.trades ?? [];
    for (const t of rows) {
      const price = Number(t.priceSol ?? 0);
      if (!(price > 0)) continue;
      out.push({ ts: Date.parse(t.timestamp), wallet: t.userAddress, side: t.type === "buy" ? 1 : -1, sol: Number(t.amountSol ?? 0), tokens: Number(t.baseAmount ?? 0), price });
    }
    const oldest = out.length ? out[out.length - 1].ts : Infinity;
    if (!j.pagination?.hasMore || !rows.length || oldest <= createdMs + 1_000) { complete = true; break; }
    cursor = j.pagination.nextCursor;
  }
  out.reverse();
  return { trades: out, complete };
}

/** 최신 한 페이지(100건) — 보유 중 매도 감시용 */
export async function fetchRecentTrades(mint: string, timeoutMs = 5_000): Promise<RugTrade[]> {
  await slot();
  const res = await fetch(TRADES_URL(mint), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`trades ${res.status}`);
  const j = (await res.json()) as { trades?: RawTrade[] };
  return (j.trades ?? []).map((t) => ({ ts: Date.parse(t.timestamp), wallet: t.userAddress, side: (t.type === "buy" ? 1 : -1) as 1 | -1, sol: Number(t.amountSol ?? 0), tokens: Number(t.baseAmount ?? 0), price: Number(t.priceSol ?? 0) })).reverse();
}

export { logger as _rugLogger };

// ===== 판정 · 감시 =====
/** 기준값은 실측(docs/pumpfun.md "러그 실측")에서 — 분석 후 채운다 */
export interface RugPolicy {
  on: number;
  /** 진입 차단 기준 (진입 시점 특징) */
  maxCreatorPct: number;
  maxTop1Pct: number;
  maxTop10Pct: number;
  maxBundlePct: number;
  maxSnipersPct: number;
  maxTradesPerWallet5m: number;
  minUniqBuyers5m: number;
  /** 보유 중 감시 — 진입 때 이만큼(공급 %) 이상 쥔 지갑·번들·개발자를 감시 */
  watchHolderPct: number;
  /** 감시 지갑이 진입 때 보유분의 이 비율 이상 팔면 전량 청산 */
  watchSellFrac: number;
  /** 누구든 한 번에 공급의 이 % 이상 팔면 전량 청산 (0 = 끔) */
  whaleSellPct: number;
  /** 보유 토큰 최근 거래 폴링 간격 (ms) */
  pollMs: number;
}
export const DEFAULT_RUG_POLICY: RugPolicy = { on: 1, maxCreatorPct: 100, maxTop1Pct: 100, maxTop10Pct: 100, maxBundlePct: 100, maxSnipersPct: 100, maxTradesPerWallet5m: 1e9, minUniqBuyers5m: 0, watchHolderPct: 2, watchSellFrac: 0.5, whaleSellPct: 0, pollMs: 5_000 };

export interface RugVerdict { block: boolean; reasons: string[]; features: RugFeatures | null; unknown: boolean }
export function rugVerdict(f: RugFeatures, p: RugPolicy): RugVerdict {
  const r: string[] = [];
  if (f.complete) {
    if (f.creatorPct !== null && f.creatorPct > p.maxCreatorPct) r.push(`creator holds ${f.creatorPct.toFixed(1)}% > ${p.maxCreatorPct}%`);
    if (f.top1Pct > p.maxTop1Pct) r.push(`top holder ${f.top1Pct.toFixed(1)}% > ${p.maxTop1Pct}%`);
    if (f.top10Pct > p.maxTop10Pct) r.push(`top-10 hold ${f.top10Pct.toFixed(0)}% > ${p.maxTop10Pct}%`);
    if (f.bundle3sPct > p.maxBundlePct) r.push(`launch bundle still holds ${f.bundle3sPct.toFixed(1)}% > ${p.maxBundlePct}%`);
    if (f.snipers60Pct > p.maxSnipersPct) r.push(`first-minute snipers hold ${f.snipers60Pct.toFixed(1)}% > ${p.maxSnipersPct}%`);
  }
  if (f.tradesPerWallet5m > p.maxTradesPerWallet5m) r.push(`wash-like: ${f.tradesPerWallet5m.toFixed(1)} trades/wallet in 5m`);
  if (f.uniqBuyers5m < p.minUniqBuyers5m) r.push(`only ${f.uniqBuyers5m} distinct buyers in 5m`);
  return { block: p.on >= 1 && r.length > 0, reasons: r, features: f, unknown: !f.complete };
}

/** 진입 때 감시할 지갑 — 개발자, 공급 watchHolderPct% 이상 보유자, 번들(첫 3초 매수자). 보유량(토큰)을 함께 */
export function watchSet(trades: RugTrade[], creator: string | null, p: RugPolicy): Map<string, number> {
  const net = new Map<string, number>(); const first = trades.length ? trades[0].ts : 0; const early = new Set<string>();
  for (const x of trades) { net.set(x.wallet, (net.get(x.wallet) ?? 0) + x.side * x.tokens); if (x.side > 0 && x.ts - first <= 3_000) early.add(x.wallet); }
  const out = new Map<string, number>();
  for (const [w, v] of net) if (v > 0 && (w === creator || early.has(w) || (v / SUPPLY) * 100 >= p.watchHolderPct)) out.set(w, v);
  return out;
}

/** 보유 중 새 거래들에서 청산 신호 — 감시 지갑의 누적 매도 비율, 단일 대량 매도 */
export function dumpSignal(newTrades: RugTrade[], watch: Map<string, number>, soldSoFar: Map<string, number>, creator: string | null, p: RugPolicy): string | null {
  for (const x of newTrades) {
    if (x.side > 0) continue;
    if (p.whaleSellPct > 0 && (x.tokens / SUPPLY) * 100 >= p.whaleSellPct) return `whale dump: one sell of ${((x.tokens / SUPPLY) * 100).toFixed(1)}% of supply`;
    const held = watch.get(x.wallet);
    if (held === undefined) continue;
    const s = (soldSoFar.get(x.wallet) ?? 0) + x.tokens; soldSoFar.set(x.wallet, s);
    if (x.wallet === creator) return `creator sold ${((x.tokens / SUPPLY) * 100).toFixed(2)}% of supply`;
    if (s >= p.watchSellFrac * held) return `watched holder ${x.wallet.slice(0, 4)}… sold ${Math.round((s / held) * 100)}% of its ${((held / SUPPLY) * 100).toFixed(1)}%`;
  }
  return null;
}
