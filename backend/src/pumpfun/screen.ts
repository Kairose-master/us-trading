import { logger } from "../core/logger.js";
import type { CoinSnapshot } from "./flow.js";

/**
 * 후보 스크린 — pump.fun 공개 API 를 30초마다 폴링해(무료) 지금 관심이 붙는 토큰의 **스냅샷 시계열**을 쌓는다.
 *   /coins?sort=last_trade_timestamp  방금 거래된 코인 50개 — 시총·커브·나이
 *   /coins/currently-live             라이브 방송 중
 *   + 데스크가 넣어 주는 졸업(이주) 이벤트
 * 유료 스트림은 여기서 뽑힌 상위 K 개에만 건다. 실측(2026-09-25): 목록 뷰의 reply_count 는 0 으로 온다 — 댓글은 상위 K 만 개별 조회.
 */

const LIST_URL = "https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false";
const LIVE_URL = "https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=20&includeNsfw=false";
// 실측(2026-09-26): /coins/{mint} 는 모든 토큰에 404 — pump.fun 이 /coins-v2/{mint} 로 옮겼다(필드 동일)
const COIN_URL = (m: string) => `https://frontend-api-v3.pump.fun/coins-v2/${m}`;
const MAX_AGE_MIN = 180;
const KEEP_SNAPS = 40;
const DROP_AFTER_MS = 20 * 60_000;

interface CoinJson { mint: string; symbol?: string; market_cap?: number; reply_count?: number; is_currently_live?: boolean; king_of_the_hill_timestamp?: number | null; complete?: boolean; created_timestamp?: number; last_trade_timestamp?: number; virtual_sol_reserves?: number; creator?: string }

export interface Candidate { mint: string; symbol: string; creator: string | null; firstSeen: number; lastSeen: number; migratedAt: number | null; snaps: CoinSnapshot[]; source: Set<string> }

let lastApiAt = 0;
async function slot() { const wait = lastApiAt + 1_100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastApiAt = Date.now(); }
async function getJson<T>(url: string, timeoutMs = 8_000): Promise<T | null> {
  await slot();
  try { let res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); if (res.status === 429) { await new Promise((r) => setTimeout(r, 1_500)); await slot(); res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); } if (!res.ok) return null; return (await res.json()) as T; }
  catch (e) { logger.warn("[pumpfun] screen fetch failed", { url: url.slice(0, 60), error: (e as Error).message }); return null; }
}

export class CandidateScreen {
  private cands = new Map<string, Candidate>();
  lastPollAt: string | null = null;
  stats = { polls: 0, coinsSeen: 0 };

  candidates(): Candidate[] { return [...this.cands.values()]; }
  get(mint: string): Candidate | undefined { return this.cands.get(mint); }

  noteMigration(mint: string, ts = Date.now()) {
    const c = this.cands.get(mint) ?? { mint, symbol: mint.slice(0, 4), creator: null, firstSeen: ts, lastSeen: ts, migratedAt: ts, snaps: [], source: new Set<string>() };
    c.migratedAt = ts; c.lastSeen = ts; c.source.add("migration"); this.cands.set(mint, c);
  }

  private snapOf(c: CoinJson, now: number): CoinSnapshot {
    return { ts: now, marketCapSol: c.market_cap ?? 0, replyCount: c.reply_count ?? 0, isLive: !!c.is_currently_live, kothAt: c.king_of_the_hill_timestamp ?? null, complete: !!c.complete, createdAt: c.created_timestamp ?? now, lastTradeAt: c.last_trade_timestamp ?? now, vSol: (c.virtual_sol_reserves ?? 0) / 1e9 };
  }
  private upsert(c: CoinJson, source: string, now: number) {
    if (!c.mint) return;
    const age = c.created_timestamp ? (now - c.created_timestamp) / 60_000 : 0;
    if (age > MAX_AGE_MIN && !this.cands.has(c.mint)) return; // 오래된 코인은 관심 밖 (이미 후보면 스냅샷은 계속)
    const cur = this.cands.get(c.mint) ?? { mint: c.mint, symbol: c.symbol ?? c.mint.slice(0, 4), creator: c.creator ?? null, firstSeen: now, lastSeen: now, migratedAt: c.complete ? now : null, snaps: [], source: new Set<string>() };
    cur.lastSeen = now; cur.source.add(source); if (c.symbol) cur.symbol = c.symbol; if (c.creator) cur.creator = c.creator;
    if (c.complete && !cur.migratedAt) cur.migratedAt = now;
    const s = this.snapOf(c, now);
    const prev = cur.snaps[cur.snaps.length - 1];
    if (prev && s.replyCount === 0 && prev.replyCount > 0) s.replyCount = prev.replyCount; // 목록 뷰는 댓글이 0 으로 온다 — 이전 값 유지
    cur.snaps.push(s); if (cur.snaps.length > KEEP_SNAPS) cur.snaps.shift();
    this.cands.set(c.mint, cur);
  }

  /** 30초 폴링 — 목록·라이브 */
  async poll() {
    const now = Date.now();
    const [list, live] = await Promise.all([getJson<CoinJson[]>(LIST_URL), getJson<CoinJson[]>(LIVE_URL)]);
    for (const c of list ?? []) this.upsert(c, "active", now);
    for (const c of live ?? []) this.upsert(c, "live", now);
    this.stats.polls += 1; this.stats.coinsSeen += (list?.length ?? 0) + (live?.length ?? 0); this.lastPollAt = new Date().toISOString();
    for (const [m, c] of this.cands) if (now - c.lastSeen > DROP_AFTER_MS) this.cands.delete(m);
  }
  /** 상위 K 후보는 개별 조회 — 댓글·라이브·KOTH 가 정확히 온다 */
  async refreshDetail(mints: string[]) {
    const now = Date.now();
    for (const m of mints.slice(0, 6)) { const c = await getJson<CoinJson>(COIN_URL(m)); if (c) this.upsert(c, "detail", now); }
  }
}
