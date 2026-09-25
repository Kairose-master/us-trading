/**
 * 흐름 신호 — 순수 함수. 두 재료를 쓴다.
 *  1) 거래 스트림(유료, PumpPortal) — 토큰별 최근 거래 링에서 순매수 SOL·고유 매수자·랭킹 지갑(봇 포함)의 순흐름을 센다.
 *     "잘 버는 봇을 따라 사지" 않고 "잘 버는 봇들이 지금 어디로 몰리는가"를 본다 — 카피 불가 지갑도 여기서는 신호다.
 *  2) pump.fun 공개 API 스냅샷(무료) — 시총·댓글·라이브·KOTH·졸업 시각의 시계열에서 모멘텀을 읽는다.
 */

export interface FlowTrade { wallet: string; side: "buy" | "sell"; sol: number; ts: number }

export interface FlowRead {
  mint: string;
  /** 전체 지갑 순매수 SOL (60s / 300s) */
  netSol60: number; netSol300: number;
  /** 랭킹 지갑(스코어 > 0 인 지갑)의 순매수 SOL (60s / 300s) 과 매수·매도 지갑 수 (60s) */
  rankedNet60: number; rankedNet300: number; rankedBuyers60: number; rankedSellers60: number;
  /** 고유 매수 지갑 수 (300s), 매수/매도 건수 비 (300s), 분당 거래 수 */
  uniqueBuyers300: number; buySellRatio300: number; tradesPerMin: number;
  /** 먼지 제외 거래 수 — 표본 크기 */
  n300: number;
}

const DUST = 0.01;

export function flowRead(mint: string, trades: FlowTrade[], now: number, rankedScore: (wallet: string) => number): FlowRead {
  const t300 = trades.filter((t) => now - t.ts <= 300_000 && t.sol >= DUST);
  const t60 = t300.filter((t) => now - t.ts <= 60_000);
  const net = (xs: FlowTrade[]) => xs.reduce((a, t) => a + (t.side === "buy" ? t.sol : -t.sol), 0);
  const ranked = (xs: FlowTrade[]) => xs.filter((t) => rankedScore(t.wallet) > 0);
  const r60 = ranked(t60), r300 = ranked(t300);
  const buyers = new Set(t300.filter((t) => t.side === "buy").map((t) => t.wallet)).size;
  const buys = t300.filter((t) => t.side === "buy").length, sells = t300.length - buys;
  return {
    mint,
    netSol60: +net(t60).toFixed(4), netSol300: +net(t300).toFixed(4),
    rankedNet60: +net(r60).toFixed(4), rankedNet300: +net(r300).toFixed(4),
    rankedBuyers60: new Set(r60.filter((t) => t.side === "buy").map((t) => t.wallet)).size,
    rankedSellers60: new Set(r60.filter((t) => t.side === "sell").map((t) => t.wallet)).size,
    uniqueBuyers300: buyers, buySellRatio300: sells > 0 ? +(buys / sells).toFixed(2) : buys > 0 ? 99 : 0,
    tradesPerMin: +(t300.length / 5).toFixed(1), n300: t300.length,
  };
}

/** pump.fun 코인 스냅샷 — 무료 폴링 (30초) */
export interface CoinSnapshot { ts: number; marketCapSol: number; replyCount: number; isLive: boolean; kothAt: number | null; complete: boolean; createdAt: number; lastTradeAt: number; vSol: number }

export interface MomentumRead {
  mint: string;
  ageMin: number;
  /** 5분 전 대비 시총 변화 % (스냅샷이 부족하면 null) */
  mcap5mPct: number | null; mcap1mPct: number | null;
  /** 5분간 댓글 증가 */
  replies5m: number | null;
  /** 졸업(이주) 후 경과 분 — 졸업 전이면 null */
  sinceMigrationMin: number | null;
  /** 커브 진행률 0~1 (졸업 전) */
  curveProgress: number | null;
  isLive: boolean; kothMinAgo: number | null;
  /** 최근 5분 최고 시총 대비 지금 */
  fromPeak5mPct: number | null;
  secondsSinceTrade: number;
}

export function momentumRead(mint: string, snaps: CoinSnapshot[], now: number, migratedAt: number | null): MomentumRead {
  const s = [...snaps].sort((a, b) => a.ts - b.ts);
  const last = s[s.length - 1];
  const at = (msAgo: number) => { const cutoff = now - msAgo; let best: CoinSnapshot | null = null; for (const x of s) { if (x.ts <= cutoff) best = x; } return best; };
  const pct = (a: CoinSnapshot | null) => (a && a.marketCapSol > 0 && last ? +(((last.marketCapSol - a.marketCapSol) / a.marketCapSol) * 100).toFixed(2) : null);
  const s5 = at(5 * 60_000), s1 = at(60_000);
  const peak5 = s.filter((x) => now - x.ts <= 5 * 60_000).reduce((m, x) => Math.max(m, x.marketCapSol), 0);
  return {
    mint,
    ageMin: last ? (now - last.createdAt) / 60_000 : 0,
    mcap5mPct: pct(s5), mcap1mPct: pct(s1),
    replies5m: s5 && last ? last.replyCount - s5.replyCount : null,
    sinceMigrationMin: migratedAt ? (now - migratedAt) / 60_000 : last?.complete ? null : null,
    curveProgress: last && !last.complete ? Math.max(0, Math.min(1, (last.vSol - 30) / 85)) : null,
    isLive: !!last?.isLive, kothMinAgo: last?.kothAt ? (now - last.kothAt) / 60_000 : null,
    fromPeak5mPct: last && peak5 > 0 ? +(((last.marketCapSol - peak5) / peak5) * 100).toFixed(2) : null,
    secondsSinceTrade: last ? (now - last.lastTradeAt) / 1000 : 9999,
  };
}
