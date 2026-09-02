import { state } from "../api/state.js";
import { logger } from "../core/logger.js";
import { currentMarketSession } from "../core/marketSession.js";
import type { Exchange } from "../kis/types.js";

/**
 * 키 없는 미국주식 실시세 — Yahoo Finance v8 chart (지연 시세, 무인증).
 * KIS 키가 없어도(MOCK_DATA=true) 파이프라인이 랜덤워크 가짜 틱이 아니라
 * 실제 가격을 먹도록 한다. 호가창(bid/ask/size)은 이 소스에 없으므로
 * bid=ask=last, size=0 으로 정직하게 넣는다 — 마이크로구조 노드는 스프레드 0,
 * OFI 0 을 그대로 보여주고, 그건 "데이터 없음"이지 지어낸 값이 아니다.
 * 계좌/포지션/주문은 여전히 KIS 모의 상태(state)라 실계좌가 아니다.
 */

const FETCH_TIMEOUT_MS = 8_000;

interface YahooQuote {
  last: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  name: string;
  exch: Exchange;
}

function exchOf(name: string | undefined): Exchange {
  if (!name) return "NAS";
  if (name.startsWith("NYQ") || name.startsWith("NYS")) return "NYS";
  if (name.startsWith("ASE") || name.startsWith("AMS")) return "AMS";
  return "NAS";
}

export async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
            regularMarketVolume?: number;
            regularMarketDayHigh?: number;
            regularMarketDayLow?: number;
            regularMarketOpen?: number;
            exchangeName?: string;
            longName?: string;
            shortName?: string;
          };
          indicators?: { quote?: Array<{ open?: Array<number | null>; volume?: Array<number | null> }> };
        }>;
      };
    };
    const r = data.chart?.result?.[0];
    const meta = r?.meta;
    const last = meta?.regularMarketPrice;
    if (!meta || typeof last !== "number") return null;
    const opens = (r?.indicators?.quote?.[0]?.open ?? []).filter((v): v is number => typeof v === "number");
    const vols = (r?.indicators?.quote?.[0]?.volume ?? []).filter((v): v is number => typeof v === "number");
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? last;
    return {
      last,
      prevClose,
      open: meta.regularMarketOpen ?? opens[0] ?? last,
      high: meta.regularMarketDayHigh ?? last,
      low: meta.regularMarketDayLow ?? last,
      volume: meta.regularMarketVolume ?? vols.reduce((a, b) => a + b, 0),
      name: meta.longName ?? meta.shortName ?? symbol,
      exch: exchOf(meta.exchangeName),
    };
  } catch {
    return null;
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * 추적 심볼을 순회하며 state.quotes를 실시세로 갱신하고 "tick"을 낸다.
 * 실패한 심볼은 이번 주기에 틱을 내지 않는다 (지어내지 않는다).
 */
export function startYahooTicks(symbols: string[], intervalMs = 15_000) {
  if (timer) return;
  const list = [...new Set(symbols)];
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    let ok = 0;
    for (const symbol of list) {
      const y = await fetchYahooQuote(symbol);
      if (!y) continue;
      const q = state.ensureQuote(symbol, y.name, y.exch, y.last);
      q.name = y.name;
      q.exch = y.exch;
      q.last = y.last;
      q.prevClose = y.prevClose;
      q.open = y.open;
      q.high = y.high;
      q.low = y.low;
      q.volume = y.volume;
      q.change = +(y.last - y.prevClose).toFixed(2);
      q.changePct = y.prevClose > 0 ? +(((y.last - y.prevClose) / y.prevClose) * 100).toFixed(2) : 0;
      q.bid = y.last; // 호가 데이터 없음 — 가짜 스프레드를 만들지 않는다
      q.ask = y.last;
      q.bidSize = 0;
      q.askSize = 0;
      q.session = currentMarketSession();
      state.emit("tick", q);
      ok++;
    }
    if (ok > 0) state.refreshPositionPrices();
    else logger.warn("Yahoo 시세 전부 실패 — 이번 주기 틱 없음", { symbols: list });
    inFlight = false;
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  logger.info("Yahoo Finance 실시세 폴링 시작 (지연 시세, 키 불필요)", { symbols: list, intervalMs });
}
