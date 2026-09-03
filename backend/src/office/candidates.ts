import type { CoinScore } from "../crypto/scanner.js";

/**
 * 오피스 후보 바구니 — 순수 함수.
 *
 * 전에는 스캐너 스코어 상위 5개(= 20일 모멘텀 1등들)를 그대로 넘겼다. 그러면 오피스는
 * "이미 가장 많이 오른 다섯 중 얼마씩"만 답할 수 있고, 꼭대기를 사는 구조가 된다.
 * 지금은:
 *   - 메이저는 항상 후보다 (BTC/ETH를 고를 권리)
 *   - 보유 중인 시장은 항상 후보다 (나갈 권리)
 *   - 나머지는 **60일 위험조정 수익**(mom60 / vol20)으로 뽑는다 — 신호 엔진의 20일과 다른 지평
 *   - 20일 +40% 이상은 과열로 제외(보유 중이면 남긴다), +25% 이상은 hot으로 표시
 *   - "포지션 없음"은 정식 답이다 (loop.ts 스코프 문구)
 */
export interface CandidateBasket { markets: string[]; hot: string[]; excluded: Array<{ market: string; why: string }>; notes: string[] }

export const OVERHEAT_MOM20_PCT = 40;
/** 후보 수 — 포지션 상한(8)보다 크다. 후보는 "볼 것", 포지션은 "살 것". 메이저 5 + 보유분 + 60일 상위가 들어갈 자리가 있어야 한다 */
export const OFFICE_CANDIDATES_MAX = 10;
export const HOT_MOM20_PCT = 25;

export function buildOfficeCandidates(p: { scores: CoinScore[]; majors: string[]; held: string[]; max?: number }): CandidateBasket {
  const max = p.max ?? OFFICE_CANDIDATES_MAX;
  const excluded: CandidateBasket["excluded"] = [];
  const hot: string[] = [];
  const out: string[] = [];
  const push = (m: string) => { if (!out.includes(m) && out.length < max) out.push(m); };
  const byMarket = new Map(p.scores.map((s) => [s.market, s]));
  for (const m of p.majors) push(m);
  for (const m of p.held) push(m);
  const ranked = p.scores
    .filter((s) => !out.includes(s.market))
    .map((s) => ({ s, key: s.mom60Pct / Math.max(s.vol20Pct, 1) }))
    .sort((a, b) => b.key - a.key);
  for (const { s, key } of ranked) {
    if (out.length >= max) break;
    if (s.pBull < 0.5) { excluded.push({ market: s.market, why: `P(bull) ${s.pBull.toFixed(2)} < 0.5` }); continue; }
    if (s.mom20Pct >= OVERHEAT_MOM20_PCT) { excluded.push({ market: s.market, why: `overheated — 20d +${s.mom20Pct.toFixed(0)}% ≥ ${OVERHEAT_MOM20_PCT}%` }); continue; }
    if (key <= 0) { excluded.push({ market: s.market, why: `60d risk-adjusted ${key.toFixed(2)} ≤ 0` }); continue; }
    push(s.market);
  }
  for (const m of out) { const s = byMarket.get(m); if (s && s.mom20Pct >= HOT_MOM20_PCT) hot.push(m); }
  const notes = [
    `candidates: majors ${p.majors.filter((m) => out.includes(m)).length}, held ${p.held.filter((m) => out.includes(m) && !p.majors.includes(m)).length}, ranked by 60d return / 20d vol ${out.filter((m) => !p.majors.includes(m) && !p.held.includes(m)).length}`,
    ...(hot.length ? [`hot (20d ≥ +${HOT_MOM20_PCT}%): ${hot.map((m) => m.replace("KRW-", "")).join(", ")} — office halves these`] : []),
    ...(excluded.filter((e) => /overheated/.test(e.why)).length ? [`excluded as overheated: ${excluded.filter((e) => /overheated/.test(e.why)).map((e) => e.market.replace("KRW-", "")).join(", ")}`] : []),
  ];
  return { markets: out, hot, excluded, notes };
}
