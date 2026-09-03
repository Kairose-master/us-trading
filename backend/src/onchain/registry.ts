import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../core/logger.js";
import { SUPPORTED_CHAINS } from "./rpc.js";

/**
 * 심볼 → 컨트랙트 주소. CoinGecko 무료 API(키 불필요, 분당 제한)를 하루 한 번만 부르고
 * 디스크에 캐시한다.
 *
 * 동명이인 문제를 지어내서 풀지 않는다: 같은 티커를 쓰는 코인이 여러 개면 **시가총액 상위**
 * 후보를 고르고, 상위 목록에 아무도 없으면 `ambiguous`로 남긴다 (추측 금지).
 */

const FILE = join(process.cwd(), "data", "onchain", "registry.json");
const TTL_MS = 24 * 60 * 60_000;
const CG = "https://api.coingecko.com/api/v3";

interface Entry { id: string; symbol: string; name: string; platforms: Record<string, string> }
interface Cache { at: number; list: Entry[]; rank: Record<string, number> }

export interface Resolution {
  symbol: string;
  status: "ok" | "native" | "ambiguous" | "unknown";
  chain?: string;
  address?: string;
  coingeckoId?: string;
  candidates?: Array<{ id: string; name: string; chains: string[] }>;
  note: string;
}

class Registry {
  private cache: Cache | null = null;
  private loading: Promise<Cache> | null = null;

  private read(): Cache | null {
    if (this.cache) return this.cache;
    try { if (existsSync(FILE)) { const c = JSON.parse(readFileSync(FILE, "utf-8")) as Cache; if (Date.now() - c.at < TTL_MS) { this.cache = c; return c; } } }
    catch (e) { logger.warn("[onchain] registry cache read failed", { error: (e as Error).message }); }
    return null;
  }

  private async load(): Promise<Cache> {
    const hit = this.read();
    if (hit) return hit;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const get = async <T>(path: string): Promise<T> => {
        const res = await fetch(`${CG}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`CoinGecko ${path} → HTTP ${res.status}`);
        return (await res.json()) as T;
      };
      const list = await get<Entry[]>("/coins/list?include_platform=true");
      const rank: Record<string, number> = {};
      for (const page of [1, 2, 3, 4]) {
        try {
          const rows = await get<Array<{ id: string; market_cap_rank: number | null }>>(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`);
          for (const r of rows) if (r.market_cap_rank) rank[r.id] = r.market_cap_rank;
        } catch (e) { logger.warn("[onchain] coingecko markets page failed", { page, error: (e as Error).message.slice(0, 120) }); }
      }
      const c: Cache = { at: Date.now(), list, rank };
      try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(c)); } catch (e) { logger.warn("[onchain] registry cache write failed", { error: (e as Error).message }); }
      this.cache = c;
      logger.info("[onchain] registry loaded", { coins: list.length, ranked: Object.keys(rank).length });
      return c;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async resolve(symbol: string): Promise<Resolution> {
    const sym = symbol.replace(/^KRW-/, "").toLowerCase();
    let c: Cache;
    try { c = await this.load(); }
    catch (e) { return { symbol, status: "unknown", note: `레지스트리를 못 읽었다: ${(e as Error).message.slice(0, 120)}` }; }
    const matches = c.list.filter((x) => x.symbol.toLowerCase() === sym);
    if (matches.length === 0) return { symbol, status: "unknown", note: "CoinGecko 목록에 이 티커가 없다" };
    const chainOf = (m: Entry) => SUPPORTED_CHAINS.find((ch) => m.platforms?.[ch]) ?? null;
    const withChain = matches.filter((m) => chainOf(m));
    const ok = (m: Entry, note: string): Resolution => { const chain = chainOf(m)!; return { symbol, status: "ok", chain, address: m.platforms[chain].toLowerCase(), coingeckoId: m.id, note }; };

    // 규칙: **이 티커를 쓰는 가장 큰 코인**이 native인지 토큰인지를 정한다.
    // KRW-BTC는 랩드 BTC가 아니라 비트코인이다 — 랩핑된 동명 토큰을 집어오면 완전히 틀린 컨트랙트를 읽는다.
    const ranked = matches.filter((m) => c.rank[m.id]).sort((a, b) => c.rank[a.id] - c.rank[b.id]);
    if (ranked.length > 0) {
      const best = ranked[0];
      if (chainOf(best)) return ok(best, `${best.name} (시총 ${c.rank[best.id]}위)${matches.length > 1 ? ` · 같은 티커 ${matches.length}개 중 최상위` : ""}`);
      return { symbol, status: "native", note: `${best.name}(시총 ${c.rank[best.id]}위)가 이 티커의 최상위이고 지원 체인에 컨트랙트가 없다 — 자체 체인 코인이라 컨트랙트 분석 대상이 아니다${withChain.length ? ` (랩드·동명 토큰 ${withChain.length}개는 다른 자산이므로 쓰지 않는다)` : ""}` };
    }
    // 시총 순위에 아무도 없다 (신규·소형). 컨트랙트를 가진 후보가 정확히 하나면 모호할 것이 없다
    if (withChain.length === 1) return ok(withChain[0], `${withChain[0].name} (시총 순위 밖 · 이 티커로 컨트랙트를 가진 유일한 후보)`);
    if (withChain.length === 0) return { symbol, status: "native", note: `지원 체인(${SUPPORTED_CHAINS.join(", ")})에 컨트랙트가 없다` };
    return { symbol, status: "ambiguous", candidates: withChain.slice(0, 5).map((m) => ({ id: m.id, name: m.name, chains: SUPPORTED_CHAINS.filter((ch) => m.platforms?.[ch]) })), note: `이 티커로 컨트랙트를 가진 토큰이 ${withChain.length}개이고 시총 순위에 아무도 없다 — 어느 것인지 추측하지 않는다` };
  }
}

export const contractRegistry = new Registry();
