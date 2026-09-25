/**
 * 지갑 스코어링 — 순수 함수. 체인은 전부 공개라 "누가 꾸준히 버는가"를 셀 수 있고, 카피 트레이딩의
 * 알파는 전부 여기서 나온다. 규칙은 카피 대상 선별의 상식을 그대로 숫자로 옮긴 것:
 *   · 표본이 있어야 한다 — 왕복(매수→매도) 거래 수 ≥ minRoundTrips
 *   · 한 방이 아니어야 한다 — 왕복별 손익의 **중앙값**이 양수 (평균은 100배 한 방에 끌려간다)
 *   · 일반화된 엣지 — 서로 다른 토큰 수 ≥ minMints
 * 점수 = 중앙값 손익률 × sqrt(왕복 수) × 승률. 순위는 이걸로, 채택은 문턱으로.
 *
 * 룩어헤드 없음: 스코어는 그 시점까지 관측한 왕복만 센다. 미실현(아직 들고 있는) 포지션은 세지 않는다 —
 * 세면 "물린 지갑"이 잘 보이는 지갑이 된다.
 */

export interface WalletTrade {
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  /** SOL 단위 (매수는 낸 SOL, 매도는 받은 SOL) */
  sol: number;
  tokens: number;
  ts: string;
}

/**
 * 먼지 거래 — 실측(2026-09-25): 졸업 토큰 거래의 절반 이상이 0.0002 SOL짜리 봇 매수(볼륨 봇·워시)다. 그걸 왕복으로 세면
 * "0.0002 SOL 사서 0.03 SOL 판" 지갑이 +3,600만%로 1등이 된다. 매수가 이 아래면 포지션이 아니라 노이즈 — 채점에서 뺀다.
 */
export const MIN_TRADE_SOL = 0.01;

export interface RoundTrip { mint: string; costSol: number; proceedsSol: number; pnlSol: number; pnlPct: number; openedAt: string; closedAt: string; holdMin: number }

export interface WalletStats {
  wallet: string;
  trades: number;
  roundTrips: number;
  mints: number;
  winRate: number;
  medianPnlPct: number;
  totalPnlSol: number;
  /** 총 매수 SOL — 규모 */
  volumeSol: number;
  medianHoldMin: number;
  score: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ScoreThresholds { minRoundTrips: number; minMints: number; minMedianPnlPct: number; minWinRate: number }
export const DEFAULT_THRESHOLDS: ScoreThresholds = { minRoundTrips: 8, minMints: 5, minMedianPnlPct: 0, minWinRate: 0.4 };
/**
 * 잠정 자격 — 관측 창이 짧아(졸업 토큰 20분×3) 정식 자격(왕복 8·토큰 5)이 첫날 안 나온다. 그래서 표본이 작아도 중앙값이 양수이고
 * 승률이 절반을 넘으면 **작게(standing 0.25)** 추종을 시작하고, 실기록이 standing 을 키우거나 굶겨 죽인다.
 */
export const PROVISIONAL_THRESHOLDS: ScoreThresholds = { minRoundTrips: 3, minMints: 2, minMedianPnlPct: 0, minWinRate: 0.5 };
export const PROVISIONAL_STANDING = 0.25;

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** 지갑·토큰별 평균단가 장부로 왕복을 만든다 — 매도가 보유의 전부/일부를 닫으면 그 비율만큼의 비용을 실현 */
export function roundTripsOf(trades: WalletTrade[]): Map<string, RoundTrip[]> {
  const out = new Map<string, RoundTrip[]>();
  const open = new Map<string, { tokens: number; costSol: number; openedAt: string }>();
  const sorted = trades.filter((t) => t.side === "sell" || t.sol >= MIN_TRADE_SOL).sort((a, b) => a.ts.localeCompare(b.ts));
  for (const t of sorted) {
    const key = `${t.wallet}|${t.mint}`;
    if (t.side === "buy") {
      const o = open.get(key);
      if (o) { o.tokens += t.tokens; o.costSol += t.sol; } else open.set(key, { tokens: t.tokens, costSol: t.sol, openedAt: t.ts });
      continue;
    }
    const o = open.get(key);
    if (!o || !(o.tokens > 0)) continue; // 우리가 매수를 못 본 매도 — 왕복이 아니다
    const frac = Math.min(1, t.tokens / o.tokens);
    const cost = o.costSol * frac;
    const rt: RoundTrip = { mint: t.mint, costSol: cost, proceedsSol: t.sol, pnlSol: t.sol - cost, pnlPct: cost > 0 ? ((t.sol - cost) / cost) * 100 : 0, openedAt: o.openedAt, closedAt: t.ts, holdMin: Math.max(0, (Date.parse(t.ts) - Date.parse(o.openedAt)) / 60_000) };
    const list = out.get(t.wallet) ?? []; list.push(rt); out.set(t.wallet, list);
    o.tokens -= t.tokens; o.costSol -= cost;
    if (o.tokens <= 1e-9) open.delete(key);
  }
  return out;
}

export function scoreWallets(trades: WalletTrade[], th: ScoreThresholds = DEFAULT_THRESHOLDS, prov: ScoreThresholds = PROVISIONAL_THRESHOLDS): { ranked: WalletStats[]; eligible: WalletStats[]; provisional: WalletStats[] } {
  const rts = roundTripsOf(trades);
  const byWallet = new Map<string, WalletTrade[]>();
  for (const t of trades) { if (t.side === "buy" && t.sol < MIN_TRADE_SOL) continue; const l = byWallet.get(t.wallet) ?? []; l.push(t); byWallet.set(t.wallet, l); }
  const ranked: WalletStats[] = [];
  for (const [wallet, list] of byWallet) {
    const r = rts.get(wallet) ?? [];
    const wins = r.filter((x) => x.pnlSol > 0).length;
    const winRate = r.length ? wins / r.length : 0;
    const medianPnlPct = median(r.map((x) => x.pnlPct));
    const totalPnlSol = r.reduce((a, x) => a + x.pnlSol, 0);
    const tss = list.map((t) => t.ts).sort();
    const score = r.length ? +(medianPnlPct * Math.sqrt(r.length) * winRate).toFixed(3) : 0;
    ranked.push({ wallet, trades: list.length, roundTrips: r.length, mints: new Set(list.map((t) => t.mint)).size, winRate: +winRate.toFixed(3), medianPnlPct: +medianPnlPct.toFixed(2), totalPnlSol: +totalPnlSol.toFixed(4), volumeSol: +list.filter((t) => t.side === "buy").reduce((a, t) => a + t.sol, 0).toFixed(3), medianHoldMin: +median(r.map((x) => x.holdMin)).toFixed(1), score, firstSeen: tss[0], lastSeen: tss[tss.length - 1] });
  }
  ranked.sort((a, b) => b.score - a.score || b.totalPnlSol - a.totalPnlSol);
  const passes = (w: WalletStats, t: ScoreThresholds) => w.roundTrips >= t.minRoundTrips && w.mints >= t.minMints && w.medianPnlPct > t.minMedianPnlPct && w.winRate >= t.minWinRate;
  const eligible = ranked.filter((w) => passes(w, th));
  const provisional = ranked.filter((w) => !passes(w, th) && passes(w, prov));
  return { ranked, eligible, provisional };
}

/** 스코어 → 초기 standing. 스코어가 클수록 크게, 하한 0.25 — 채택 직후엔 아직 실기록이 없다 */
export function initialStanding(w: WalletStats, top: number): number {
  return top > 0 ? +Math.max(0.25, Math.min(1, w.score / top)).toFixed(3) : 0.5;
}
