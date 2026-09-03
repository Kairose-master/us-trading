import { logger } from "../core/logger.js";
import { cryptoUniverse } from "../crypto/universe.js";
import { getDayCandles } from "../crypto/candle-store.js";
import { contractDesk } from "./contract-desk.js";
import { blockTimestamp, getLogsHistory } from "./rpc.js";
import { ALL_TOPICS, decodeScheduled, type ScheduledCall } from "./timelock.js";
import { eventStudyStats, priceEvents, type DisclosedEvent, type EventStudyResult, type PricedEvent } from "./event-study.js";

/**
 * 검증 데스크 — "임박한 악재 예정을 피하면 실제로 도움이 되나"를 잰다.
 *
 * 오피스 리스크 총괄은 이미 이 신호로 비중을 깎는다(etaMultiplier). 이 데스크는 그 규칙이
 * 근거가 있는지를 사후에 재본다 — **룩어헤드 없이**. 쓰는 사실은 딱 하나: 그 블록 시각에
 * 그 이벤트가 났다는 것. target·calldata·eta는 그 순간 이미 온체인에 공개돼 있었으므로,
 * "공표 시점부터 eta까지 보유했으면 벤치마크 대비 어땠나"는 미래 정보를 쓰지 않는다.
 *
 * 오늘의 owner·심각도 분류를 과거 가격에 되돌려 적용하는 것과는 다르다 — 그건 룩어헤드다.
 * 여기서 하는 것도 아니다: 컨트랙트 발견(owner가 타임락인지)은 "지금" 판정이지만, 사건
 * 자체(공표·eta)는 그 사건이 난 순간의 사실이고 그 시점 이후 가격만 쓴다.
 */

const HISTORY_SPAN_BLOCKS = 1_296_000; // ≈180일 (12초/블록) — 더 늘리면 청크 수·RPC 호출이 선형으로 는다
const TTL_MS = 24 * 60 * 60_000; // 새 사건이 나는 빈도 자체가 낮다 (실측: 두 토큰에서 180일에 2건)

export interface TokenEventReport {
  symbol: string;
  timelockAddress: string;
  window: { fromBlock: number; toBlock: number };
  adverseFound: number;
  priced: PricedEvent[];
  skipped: Array<{ key: string; why: string }>;
}

export interface VerifyReport {
  ts: string;
  historySpanDays: number;
  /** owner가 타임락인 유니버스 종목 (분모 — 대부분은 여기 안 든다) */
  timelockedSymbols: string[];
  perToken: TokenEventReport[];
  pooled: EventStudyResult;
  note: string;
}

async function tokenEvents(symbol: string, chain: string, timelockAddress: string): Promise<TokenEventReport> {
  const hist = await getLogsHistory({ chain, address: timelockAddress, topics: [ALL_TOPICS], totalSpanBlocks: HISTORY_SPAN_BLOCKS });
  const calls = hist.logs.map(decodeScheduled).filter((x): x is ScheduledCall => Boolean(x));
  const adverse = calls.filter((c) => c.adverse);
  const events: DisclosedEvent[] = [];
  const skipped: Array<{ key: string; why: string }> = [];
  for (const c of adverse) {
    const ts = await blockTimestamp(chain, c.blockNumber);
    if (ts === null) { skipped.push({ key: c.key, why: "블록 타임스탬프를 못 읽었다" }); continue; }
    const eta = c.etaSec ?? (c.delaySec !== null ? ts + c.delaySec : null); // Compound는 이벤트에 eta 직접, OZ는 공표시각+delay(컨트랙트 로직 그대로)
    if (eta === null) { skipped.push({ key: c.key, why: "eta를 못 구했다 (delay 미확인)" }); continue; }
    events.push({ market: `KRW-${symbol}`, key: c.key, impact: c.impact, announceIso: new Date(ts * 1000).toISOString(), etaIso: new Date(eta * 1000).toISOString() });
  }
  const [tokenCandles, btcCandles] = await Promise.all([getDayCandles(`KRW-${symbol}`, 400), getDayCandles("KRW-BTC", 400)]);
  const priceMap: Record<string, Record<string, number>> = { [`KRW-${symbol}`]: {}, "KRW-BTC": {} };
  for (const c of tokenCandles) priceMap[`KRW-${symbol}`][c.t] = c.c;
  for (const c of btcCandles) priceMap["KRW-BTC"][c.t] = c.c;
  const price = (m: string, iso: string) => priceMap[m]?.[iso.slice(0, 10)] ?? null;
  const priced = priceEvents(events, price, "KRW-BTC");
  for (const e of events) if (!priced.some((p) => p.key === e.key)) skipped.push({ key: e.key, why: "그 구간의 일봉 가격이 없다" });
  return { symbol, timelockAddress, window: { fromBlock: hist.fromBlock, toBlock: hist.toBlock }, adverseFound: adverse.length, priced, skipped };
}

class VerifyDesk {
  private cache: { at: number; data: VerifyReport } | null = null;
  private inflight: Promise<VerifyReport> | null = null;

  async report(force = false): Promise<VerifyReport> {
    if (!force && this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.data;
    if (this.inflight) return this.inflight;
    this.inflight = this.build().then((data) => { this.cache = { at: Date.now(), data }; return data; }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async build(): Promise<VerifyReport> {
    const ts = new Date().toISOString();
    const symbols = cryptoUniverse.symbols();
    const timelocked: Array<{ symbol: string; chain: string; address: string }> = [];
    for (const s of symbols) {
      try {
        const r = await contractDesk.report(s);
        if (r.profile && r.timelock?.owner.kind === "timelock" && r.timelock.timelock) {
          timelocked.push({ symbol: s, chain: r.profile.chain, address: r.timelock.timelock.address });
        }
      } catch (e) { logger.warn("[verify] contract lookup failed", { symbol: s, error: (e as Error).message.slice(0, 120) }); }
    }
    logger.info("[verify] timelocked symbols in universe", { symbols: timelocked.map((t) => t.symbol) });
    const perToken: TokenEventReport[] = [];
    for (const t of timelocked) {
      try { perToken.push(await tokenEvents(t.symbol, t.chain, t.address)); }
      catch (e) { logger.warn("[verify] token event study failed", { symbol: t.symbol, error: (e as Error).message.slice(0, 160) }); perToken.push({ symbol: t.symbol, timelockAddress: t.address, window: { fromBlock: 0, toBlock: 0 }, adverseFound: 0, priced: [], skipped: [{ key: "-", why: (e as Error).message.slice(0, 160) }] }); }
    }
    const pooledPriced = perToken.flatMap((p) => p.priced);
    const pooled = eventStudyStats(pooledPriced, { seed: 11 });
    const note = timelocked.length === 0
      ? "유니버스에 owner가 타임락인 종목이 없다 — 잴 게 없다"
      : pooledPriced.length === 0
        ? `owner가 타임락인 종목 ${timelocked.length}개(${timelocked.map((t) => t.symbol).join(",")})를 봤지만 최근 ${Math.round(HISTORY_SPAN_BLOCKS / 7200)}일 안에 가격까지 붙는 악재 예정이 없었다`
        : pooled.note;
    return { ts, historySpanDays: Math.round(HISTORY_SPAN_BLOCKS / 7200), timelockedSymbols: timelocked.map((t) => t.symbol), perToken, pooled, note };
  }
}

export const verifyDesk = new VerifyDesk();
