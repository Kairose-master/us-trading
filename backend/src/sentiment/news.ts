import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { logger } from "../core/logger.js";

/**
 * 비정형 데이터 수집기 — 종목별 뉴스 헤드라인.
 * 실모드: Google News RSS (키 불필요). MOCK_DATA 또는 fetch 실패: 합성 헤드라인 폴백.
 * 어느 쪽이든 아이템에 source가 남아 실데이터/목데이터가 구분된다.
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

export class NewsIngestor extends EventEmitter {
  private symbols: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private cursor = 0;
  /** 최근 수집분 (프론트 피드/재기동용) */
  recent: NewsItem[] = [];

  setSymbols(symbols: string[]) {
    this.symbols = [...new Set(symbols)];
  }

  start() {
    if (this.timer) return;
    if (config.MOCK_DATA) {
      this.timer = setInterval(() => this.emitMock(), MOCK_INTERVAL_MS);
      // 첫 헤드라인은 바로
      setTimeout(() => this.emitMock(), 2_000);
      logger.info("뉴스 수집기 기동 (MOCK 헤드라인 모드)");
    } else {
      const step = Math.max(15_000, Math.floor(POLL_INTERVAL_MS / Math.max(1, this.symbols.length)));
      this.timer = setInterval(() => void this.pollNext(), step);
      void this.pollNext();
      logger.info("뉴스 수집기 기동 (Google News RSS)", { symbols: this.symbols });
    }
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private push(items: NewsItem[]) {
    const fresh = items.filter((i) => !this.seen.has(i.id));
    if (fresh.length === 0) return;
    for (const i of fresh) {
      this.seen.add(i.id);
      this.recent.unshift(i);
    }
    if (this.recent.length > 200) this.recent.length = 200;
    if (this.seen.size > 2000) this.seen = new Set(this.recent.map((i) => i.id));
    this.emit("news", fresh);
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

  private async pollNext() {
    if (this.symbols.length === 0) return;
    const symbol = this.symbols[this.cursor % this.symbols.length];
    this.cursor++;
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${symbol} stock`)}&hl=en-US&gl=US&ceid=US:en`;
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
      this.push(items);
    } catch (e) {
      logger.warn("뉴스 수집 실패 — 다음 주기에 재시도", { symbol, error: (e as Error).message });
    }
  }
}

export const newsIngestor = new NewsIngestor();
