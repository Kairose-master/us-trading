import { logger } from "../core/logger.js";
import { config } from "../config.js";
import { solanaRpc, tokenBalance } from "./solana-rpc.js";

/**
 * 커뮤니티 데스크 — 밈코인은 펀더멘털이 없고 **커뮤니티가 가격**이다. 그래서 카피 매수 직전에 그 토큰의 커뮤니티를 읽어
 * 크기를 곱하거나(×0.5~×1.25) 아예 거른다. 헤드라인 감성이 아니라 **관측 가능한 사실**만 쓴다 (docs/onchain-contracts.md의 원칙):
 *
 *   pump.fun 공개 API (frontend-api-v3.pump.fun/coins/:mint, 키 없음, 실측 2026-09-25)
 *     reply_count(댓글 수), king_of_the_hill_timestamp, twitter/telegram/website, is_currently_live(라이브 방송),
 *     usd_market_cap vs ath_market_cap, created_timestamp, security_verdict, creator
 *   텔레그램 공개 페이지 (t.me/<채널>) — "N subscribers/members" 를 읽는다. 초대 링크(t.me/+…)는 못 읽는다
 *   온체인 홀더 집중도 — getTokenLargestAccounts 는 공개 RPC가 막는다(실측). PUMPFUN_RPC_URL(Helius 등)이 있을 때만
 *   creator 이력 — 우리 create 스트림에서 같은 creator 가 48h 안에 몇 개를 찍었나 (연쇄 발행자 = 러그 공장)
 *
 * 근거: 텔레그램 채널이 있는 런치는 없는 런치보다 졸업률이 ~9배 (SSRN 2026, 832,941 런치). 댓글·라이브·KOTH 는 관심의 흐름 자체.
 * 정직성: 데이터가 안 오면 "모른다"(unknown)로 두고 ×0.75 — 양성으로도, 차단으로도 취급하지 않는다.
 */

export interface CommunityFacts {
  mint: string;
  fetchedAt: string;
  ok: boolean;
  symbol: string | null;
  creator: string | null;
  ageMin: number | null;
  replyCount: number | null;
  /** 이전 읽기 대비 댓글 증가 (분당) — 같은 mint 를 두 번 이상 읽었을 때만 */
  replyPerMin: number | null;
  kothMinAgo: number | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  telegramMembers: number | null;
  isLive: boolean;
  mcapUsd: number | null;
  athMcapUsd: number | null;
  /** ATH 대비 현재 시총 (0~1) */
  fromAth: number | null;
  securityVerdict: string | null;
  complete: boolean | null;
  /** 상위 10 홀더(커브·풀 제외) 비중 0~1. RPC 가 지원할 때만 */
  top10Share: number | null;
  /** 같은 creator 가 최근 48h 에 찍은 토큰 수 (이 토큰 포함) */
  creatorLaunches48h: number | null;
  /** 러그 감시 — creator 지갑이 든 공급 비중 (%), 창설 때 creator 의 초기 매수 SOL (우리 스트림이 봤을 때만) */
  creatorSharePct: number | null;
  creatorInitialBuySol: number | null;
}

export interface CommunityRead {
  score: number;
  /** 카피 크기에 곱한다. 0 이면 거른다 */
  multiplier: number;
  block: boolean;
  unknown: boolean;
  reasons: string[];
  facts: CommunityFacts;
}

export interface CommunityPolicy { minScore: number; gate: number }
export const DEFAULT_COMMUNITY_POLICY: CommunityPolicy = { minScore: 40, gate: 1 };

const COIN_URL = (mint: string) => `https://frontend-api-v3.pump.fun/coins/${mint}`;
// pump.fun 공개 API 는 키 없는 대신 빡빡하다 — 프로세스 전역 초당 1회
let lastPumpApiAt = 0;
async function pumpApiSlot() { const wait = lastPumpApiAt + 1_000 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastPumpApiAt = Date.now(); }
const CACHE_MS = 60_000;
const TG_CACHE_MS = 10 * 60_000;

/** 사실 → 점수. 순수 함수 — 규칙이 표로 읽히게 */
export function scoreCommunity(f: CommunityFacts, p: CommunityPolicy = DEFAULT_COMMUNITY_POLICY): CommunityRead {
  const reasons: string[] = [];
  if (!f.ok) return { score: 50, multiplier: 0.75, block: false, unknown: true, reasons: ["community data unavailable — unknown, ×0.75"], facts: f };
  let s = 50;
  const add = (d: number, why: string) => { s += d; reasons.push(`${d >= 0 ? "+" : ""}${d} ${why}`); };
  if (f.securityVerdict && f.securityVerdict !== "allow") { return { score: 0, multiplier: 0, block: true, unknown: false, reasons: [`security verdict ${f.securityVerdict} — blocked`], facts: f }; }
  if (f.creatorLaunches48h !== null && f.creatorLaunches48h >= 10) return { score: 0, multiplier: 0, block: true, unknown: false, reasons: [`creator launched ${f.creatorLaunches48h} tokens in 48h — serial launcher, blocked`], facts: f };
  if (f.top10Share !== null && f.top10Share >= 0.8) return { score: 0, multiplier: 0, block: true, unknown: false, reasons: [`top-10 holders own ${(f.top10Share * 100).toFixed(0)}% — blocked`], facts: f };
  // 러그 감시 — 만든 사람이 물량을 쥐고 있으면 팔 사람도 그 사람이다
  if (f.creatorSharePct !== null && f.creatorSharePct >= 10) return { score: 0, multiplier: 0, block: true, unknown: false, reasons: [`creator holds ${f.creatorSharePct.toFixed(1)}% of supply — rug risk, blocked`], facts: f };
  if (f.creatorInitialBuySol !== null && f.creatorInitialBuySol >= 5) return { score: 0, multiplier: 0, block: true, unknown: false, reasons: [`creator bought ${f.creatorInitialBuySol.toFixed(1)} SOL at launch — bundled supply, blocked`], facts: f };

  if (f.twitter) add(10, "twitter linked");
  if (f.telegram) { add(10, "telegram linked"); if (f.telegramMembers !== null) { if (f.telegramMembers >= 2000) add(10, `telegram ${f.telegramMembers} members`); else if (f.telegramMembers >= 500) add(5, `telegram ${f.telegramMembers} members`); else if (f.telegramMembers < 50) add(-5, `telegram only ${f.telegramMembers} members`); } }
  if (f.website) add(5, "website linked");
  if (f.replyCount !== null) { if (f.replyCount >= 50) add(15, `${f.replyCount} replies`); else if (f.replyCount >= 10) add(10, `${f.replyCount} replies`); else if (f.replyCount === 0 && (f.ageMin ?? 0) > 10) add(-10, "no replies after 10 min"); }
  if (f.replyPerMin !== null && f.replyPerMin >= 2) add(10, `replies growing ${f.replyPerMin.toFixed(1)}/min`);
  if (f.isLive) add(10, "creator is live-streaming");
  if (f.kothMinAgo !== null && f.kothMinAgo <= 30) add(10, `king of the hill ${f.kothMinAgo.toFixed(0)}m ago`);
  if (f.creatorLaunches48h !== null && f.creatorLaunches48h >= 3) add(-25, `creator launched ${f.creatorLaunches48h} tokens in 48h`);
  if (f.creatorSharePct !== null && f.creatorSharePct >= 4) add(-20, `creator holds ${f.creatorSharePct.toFixed(1)}%`);
  if (f.creatorInitialBuySol !== null && f.creatorInitialBuySol >= 2) add(-15, `creator bought ${f.creatorInitialBuySol.toFixed(1)} SOL at launch`);
  if (f.top10Share !== null && f.top10Share >= 0.5) add(-20, `top-10 holders own ${(f.top10Share * 100).toFixed(0)}%`);
  if (f.fromAth !== null && f.fromAth <= 0.3) add(-15, `${((1 - f.fromAth) * 100).toFixed(0)}% below ATH — community left`);
  s = Math.max(0, Math.min(100, s));
  const block = p.gate >= 1 && s < p.minScore;
  const multiplier = block ? 0 : s >= 80 ? 1.25 : s >= 60 ? 1 : 0.5;
  if (block) reasons.push(`score ${s} < ${p.minScore} — skipped`);
  return { score: s, multiplier, block, unknown: false, reasons, facts: f };
}

interface CoinJson { symbol?: string; creator?: string; created_timestamp?: number; reply_count?: number; king_of_the_hill_timestamp?: number | null; twitter?: string | null; telegram?: string | null; website?: string | null; is_currently_live?: boolean; usd_market_cap?: number; ath_market_cap?: number; complete?: boolean; security_verdict?: { verdict?: string } | null }

export class CommunityDesk {
  private cache = new Map<string, { read: CommunityRead; at: number }>();
  private tgCache = new Map<string, { members: number | null; at: number }>();
  private lastReply = new Map<string, { count: number; at: number }>();
  /** creator → 최근 48h 생성 시각 — 데스크가 create 이벤트마다 넣어 준다 */
  private launches = new Map<string, number[]>();
  /** mint → 창설 때 creator 초기 매수 SOL (스트림이 본 토큰만) */
  private initialBuys = new Map<string, number>();
  private recent: CommunityRead[] = [];
  policy: CommunityPolicy = DEFAULT_COMMUNITY_POLICY;
  stats = { reads: 0, blocked: 0, unknown: 0 };

  noteLaunch(creator: string, ts = Date.now(), mint?: string, initialBuySol?: number) {
    if (mint && initialBuySol !== undefined) { this.initialBuys.set(mint, initialBuySol); if (this.initialBuys.size > 20_000) { const first = this.initialBuys.keys().next().value; if (first) this.initialBuys.delete(first); } }
    if (!creator) return;
    const cutoff = ts - 48 * 3_600_000;
    const l = (this.launches.get(creator) ?? []).filter((t) => t >= cutoff); l.push(ts); this.launches.set(creator, l);
    if (this.launches.size > 50_000) { for (const [k, v] of this.launches) { if (v.every((t) => t < cutoff)) this.launches.delete(k); } }
  }
  creatorLaunches48h(creator: string | null): number | null {
    if (!creator) return null;
    const cutoff = Date.now() - 48 * 3_600_000;
    return (this.launches.get(creator) ?? []).filter((t) => t >= cutoff).length || null;
  }

  async read(mint: string, opts: { force?: boolean; timeoutMs?: number } = {}): Promise<CommunityRead> {
    const c = this.cache.get(mint);
    if (c && !opts.force && Date.now() - c.at < CACHE_MS) return c.read;
    const timeout = opts.timeoutMs ?? 5_000;
    const facts = await this.facts(mint, timeout);
    const read = scoreCommunity(facts, this.policy);
    this.stats.reads += 1; if (read.block) this.stats.blocked += 1; if (read.unknown) this.stats.unknown += 1;
    this.cache.set(mint, { read, at: Date.now() });
    this.recent.push(read); if (this.recent.length > 100) this.recent.shift();
    return read;
  }
  cached(mint: string): CommunityRead | null { return this.cache.get(mint)?.read ?? null; }
  recentReads(limit = 30) { return this.recent.slice(-limit).reverse(); }

  private async facts(mint: string, timeoutMs: number): Promise<CommunityFacts> {
    const base: CommunityFacts = { mint, fetchedAt: new Date().toISOString(), ok: false, symbol: null, creator: null, ageMin: null, replyCount: null, replyPerMin: null, kothMinAgo: null, twitter: null, telegram: null, website: null, telegramMembers: null, isLive: false, mcapUsd: null, athMcapUsd: null, fromAth: null, securityVerdict: null, complete: null, top10Share: null, creatorLaunches48h: null, creatorSharePct: null, creatorInitialBuySol: null };
    let coin: CoinJson;
    try {
      // 실측: accept/user-agent 헤더를 붙이면 429, 기본 헤더면 200 — 헤더 없이 부르고, 429 는 1초 뒤 한 번 재시도
      await pumpApiSlot();
      let res = await fetch(COIN_URL(mint), { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 1_200)); await pumpApiSlot(); res = await fetch(COIN_URL(mint), { signal: AbortSignal.timeout(timeoutMs) }); }
      if (!res.ok) { logger.warn("[pumpfun] community: coin fetch failed", { mint: mint.slice(0, 8), status: res.status }); return base; }
      coin = (await res.json()) as CoinJson;
    } catch (e) { logger.warn("[pumpfun] community: coin fetch error", { mint: mint.slice(0, 8), error: (e as Error).message }); return base; }
    const now = Date.now();
    const f: CommunityFacts = { ...base, ok: true, symbol: coin.symbol ?? null, creator: coin.creator ?? null, ageMin: coin.created_timestamp ? (now - coin.created_timestamp) / 60_000 : null, replyCount: typeof coin.reply_count === "number" ? coin.reply_count : null, kothMinAgo: coin.king_of_the_hill_timestamp ? (now - coin.king_of_the_hill_timestamp) / 60_000 : null, twitter: coin.twitter || null, telegram: coin.telegram || null, website: coin.website || null, isLive: !!coin.is_currently_live, mcapUsd: coin.usd_market_cap ?? null, athMcapUsd: coin.ath_market_cap ?? null, fromAth: coin.usd_market_cap && coin.ath_market_cap ? coin.usd_market_cap / coin.ath_market_cap : null, securityVerdict: coin.security_verdict?.verdict ?? null, complete: coin.complete ?? null, creatorLaunches48h: this.creatorLaunches48h(coin.creator ?? null) };
    if (f.replyCount !== null) { const prev = this.lastReply.get(mint); if (prev && now - prev.at >= 30_000) f.replyPerMin = ((f.replyCount - prev.count) / (now - prev.at)) * 60_000; this.lastReply.set(mint, { count: f.replyCount, at: now }); }
    const [tg, top, creatorBal] = await Promise.all([
      f.telegram ? this.telegramMembers(f.telegram, Math.min(timeoutMs, 4_000)) : Promise.resolve(null),
      config.PUMPFUN_RPC_URL ? this.top10(mint).catch(() => null) : Promise.resolve(null),
      f.creator ? tokenBalance(f.creator, mint).catch(() => null) : Promise.resolve(null),
    ]);
    f.telegramMembers = tg; f.top10Share = top;
    f.creatorSharePct = creatorBal === null ? null : +((creatorBal / 1_000_000_000) * 100).toFixed(2);
    f.creatorInitialBuySol = this.initialBuys.get(mint) ?? null;
    return f;
  }

  /** 편입·마킹용 최소 정보 — 시총(SOL)·완료 여부·커브 주소 */
  async coinBasics(mint: string, timeoutMs = 5_000): Promise<{ marketCapSol: number; complete: boolean; bondingCurve: string | null; symbol: string | null } | null> {
    await pumpApiSlot();
    const res = await fetch(COIN_URL(mint), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const c = (await res.json()) as CoinJson & { market_cap?: number; bonding_curve?: string };
    return { marketCapSol: c.market_cap ?? 0, complete: !!c.complete, bondingCurve: c.bonding_curve ?? null, symbol: c.symbol ?? null };
  }

  /** t.me/<채널> 공개 페이지의 "N subscribers" — 초대 링크(+…)나 개인 계정은 null */
  async telegramMembers(url: string, timeoutMs = 4_000): Promise<number | null> {
    const m = /t\.me\/([A-Za-z0-9_]{4,})/.exec(url);
    if (!m || url.includes("t.me/+")) return null;
    const handle = m[1].toLowerCase();
    const c = this.tgCache.get(handle); if (c && Date.now() - c.at < TG_CACHE_MS) return c.members;
    let members: number | null = null;
    try {
      const res = await fetch(`https://t.me/${m[1]}`, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(timeoutMs) });
      const html = await res.text();
      const mm = /([\d\s,.]+)\s*(subscribers|members)/i.exec(html);
      if (mm) members = Number(mm[1].replace(/[\s,.]/g, "")) || null;
    } catch { /* unknown */ }
    this.tgCache.set(handle, { members, at: Date.now() });
    return members;
  }

  /** 상위 20 계정 중 커브/풀 계정(가장 큰 하나로 가정… 은 위험) 대신: 총공급 대비 상위 10(첫 번째 = 커브 제외) 비중 */
  private async top10(mint: string): Promise<number | null> {
    const r = await solanaRpc<{ value: Array<{ uiAmount: number | null }> }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    const amounts = (r?.value ?? []).map((x) => x.uiAmount ?? 0).sort((a, b) => b - a);
    if (amounts.length < 2) return null;
    // 첫 번째는 본딩커브/풀 계정이라고 보고 제외 — 남은 상위 10 을 유통 공급(10억 − 커브 보유)으로 나눈다
    const circulating = 1_000_000_000 - amounts[0];
    if (circulating <= 0) return null;
    return Math.min(1, amounts.slice(1, 11).reduce((a, b) => a + b, 0) / circulating);
  }
}

export const communityDesk = new CommunityDesk();
