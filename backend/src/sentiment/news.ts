import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { supervisor } from "../core/supervisor.js";
import { logger } from "../core/logger.js";

/**
 * 비정형 데이터 수집기 — 종목별 뉴스 헤드라인.
 * 기본: Google News RSS (키 불필요 — MOCK_DATA와 무관하게 항상 실데이터).
 * 합성 헤드라인은 NEWS_MOCK=true 로 명시했을 때만 (source="Mock*"로 구분).
 * fetch 실패 시 폴백은 없다 — 그 주기엔 아무것도 내지 않고 다음 주기에 재시도.
 */

export interface NewsItem {
  id: string;
  symbol: string;
  title: string;
  source: string; // 매체명 또는 "mock"
  url: string | null;
  publishedAt: string;
  fetchedAt: string;
}

const POLL_INTERVAL_MS = 3 * 60_000; // 심볼당 3분 (전체는 스태거)
const MOCK_INTERVAL_MS = 20_000;

const MOCK_TEMPLATES: Array<[string, string]> = [
  ["{sym} shares surge after earnings beat expectations", "MockWire"],
  ["{sym} falls as analysts cut price target on margin concerns", "MockWire"],
  ["{sym} announces record quarterly revenue growth", "MockDaily"],
  ["Regulators open probe into {sym} business practices", "MockDaily"],
  ["{sym} upgraded to buy at MockBank on strong demand", "MockBank"],
  ["{sym} warns of supply delays, shares drop", "MockWire"],
  ["{sym} expands partnership, momentum builds", "MockDaily"],
  ["{sym} misses on revenue, stock slides in after hours", "MockWire"],
];

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** RSS <item> 최소 파싱 — 의존성 없이 title/pubDate/source/link만 뽑는다 */
export function parseRssItems(xml: string): Array<{ title: string; pubDate: string; source: string; link: string }> {
  const items: Array<{ title: string; pubDate: string; source: string; link: string }> = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && items.length < 20) {
    const block = m[1];
    const pick = (tag: string) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      return r ? r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim() : "";
    };
    const title = decodeEntities(pick("title"));
    if (!title) continue;
    items.push({
      title,
      pubDate: pick("pubDate"),
      source: decodeEntities(pick("source")) || "GoogleNews",
      link: pick("link"),
    });
  }
  return items;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export interface NewsIngestorOpts {
  /** 심볼 → 검색 쿼리 (기본 "{sym} stock"; 크립토 데스크는 "{sym} crypto") */
  queryFor?: (symbol: string) => string;
  /** 감독자에 등록될 소스 id/시장 — 기본 us */
  sourceId?: string;
  market?: "us" | "crypto";
  /** true면 합성 헤드라인 모드 (기본: config.NEWS_MOCK — 명시적 opt-in) */
  mockMode?: boolean;
}

export class NewsIngestor extends EventEmitter {
  private symbols: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private cursor = 0;
  private queryFor: (symbol: string) => string;
  private sourceId: string;
  private market: "us" | "crypto";
  private mockMode: boolean;
  /** 최근 수집분 (프론트 피드/재기동용) */
  recent: NewsItem[] = [];

  constructor(opts: NewsIngestorOpts = {}) {
    super();
    this.queryFor = opts.queryFor ?? ((s) => `${s} stock`);
    this.sourceId = opts.sourceId ?? "news-rss-us";
    this.market = opts.market ?? "us";
    this.mockMode = opts.mockMode ?? config.NEWS_MOCK;
  }

  setSymbols(symbols: string[]) {
    this.symbols = [...new Set(symbols)];
  }

  start() {
    if (this.timer) return;
    if (this.mockMode) {
      this.timer = setInterval(() => this.emitMock(), MOCK_INTERVAL_MS);
      // 첫 헤드라인은 바로
      setTimeout(() => this.emitMock(), 2_000);
      logger.info("뉴스 수집기 기동 (MOCK 헤드라인 모드)");
    } else {
      const step = Math.max(15_000, Math.floor(POLL_INTERVAL_MS / Math.max(1, this.symbols.length)));
      // 감독자 아래로: 실패는 백오프 재시도, 회복 시 전 심볼 RSS를 다시 받아 놓친 기사를 백필한다
      supervisor.register({
        id: this.sourceId,
        name: `Google News RSS (${this.market})`,
        market: this.market,
        feedsNode: "news-stream",
        intervalMs: step,
        slaMs: POLL_INTERVAL_MS * 2,
        run: () => this.pollNext(),
        backfill: async () => {
          let rows = 0;
          for (let i = 0; i < this.symbols.length; i++) rows += (await this.pollNext()).rows;
          return { rows, note: `re-fetched RSS for ${this.symbols.length} symbols — fresh headlines only, duplicates dropped` };
        },
      });
      this.timer = setInterval(() => undefined, 60_000); // start() 중복 호출 가드
      logger.info("뉴스 수집기 기동 (Google News RSS)", { symbols: this.symbols, sourceId: this.sourceId });
    }
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private push(items: NewsItem[]): number {
    const fresh = items.filter((i) => !this.seen.has(i.id));
    if (fresh.length === 0) return 0;
    for (const i of fresh) {
      this.seen.add(i.id);
      this.recent.unshift(i);
    }
    if (this.recent.length > 200) this.recent.length = 200;
    if (this.seen.size > 2000) this.seen = new Set(this.recent.map((i) => i.id));
    this.emit("news", fresh);
    return fresh.length;
  }

  private emitMock() {
    if (this.symbols.length === 0) return;
    const symbol = this.symbols[Math.floor(Math.random() * this.symbols.length)];
    const [tpl, source] = MOCK_TEMPLATES[Math.floor(Math.random() * MOCK_TEMPLATES.length)];
    const title = tpl.replace("{sym}", symbol);
    const now = new Date().toISOString();
    this.push([
      {
        id: hashId(`${symbol}:${title}:${now.slice(0, 16)}`),
        symbol,
        title,
        source,
        url: null,
        publishedAt: now,
        fetchedAt: now,
      },
    ]);
  }

  /** 다음 심볼 하나를 수집 — 감독자가 돌린다. 실패는 throw (감독자가 재시도) */
  private async pollNext(): Promise<{ rows: number; note?: string }> {
    if (this.symbols.length === 0) return { rows: 0 };
    const symbol = this.symbols[this.cursor % this.symbols.length];
    this.cursor++;
    {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(this.queryFor(symbol))}&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const now = new Date().toISOString();
      const items = parseRssItems(xml).map((r) => ({
        id: hashId(`${symbol}:${r.title}`),
        symbol,
        title: r.title.replace(/ - [^-]+$/, ""), // 구글뉴스는 제목 끝에 " - 매체명"을 붙인다
        source: r.source,
        url: r.link || null,
        publishedAt: r.pubDate ? new Date(r.pubDate).toISOString() : now,
        fetchedAt: now,
      }));
      const fresh = this.push(items);
      return { rows: fresh, note: `${symbol}: ${items.length} items, ${fresh} fresh` };
    }
  }
}

export const newsIngestor = new NewsIngestor();
