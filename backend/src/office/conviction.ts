/**
 * 오피스 확신도 — 순수 함수. "9/9 단계 통과 = 확신도 1.0"을 끝낸다.
 * 확신도는 퀀트 데스크가 실제로 잰 우위(μ̂/σ̂·√n, t값)에서 나온다. t≈0이면 0.3, t≥2면 0.9, t≤−0.7이면 0.1.
 */
export interface QuantEdge { market: string; muPctD: number; sigmaPctD: number; n: number; t: number }

/** 워커 퀀트 보고서: `## KRW-X — … (199 returns)` … `μ̂=0.029%/d σ̂=3.97%/d` */
export function parseQuantEdge(text: string): QuantEdge[] {
  const out: QuantEdge[] = [];
  for (const sec of text.split(/\n(?=## )/)) {
    const m = sec.match(/^## (KRW-[A-Z0-9]+)[^\n]*\((\d+) returns\)/); if (!m) continue;
    const e = sec.match(/μ̂=([\d.-]+)%\/d σ̂=([\d.]+)%\/d/); if (!e) continue;
    const mu = Number(e[1]), sigma = Number(e[2]), n = Number(m[2]);
    if (!(sigma > 0) || !(n > 1)) continue;
    out.push({ market: m[1], muPctD: mu, sigmaPctD: sigma, n, t: +((mu / sigma) * Math.sqrt(n)).toFixed(3) });
  }
  return out;
}

/** 워커 차트 보고서: `## KRW-X — ₩181 (+5.85% 24h)` … `+71.43% over 20 sessions` */
export interface ChartMomentum { market: string; chg24hPct: number | null; mom20Pct: number | null }
export function parseChartMomentum(text: string): ChartMomentum[] {
  const out: ChartMomentum[] = [];
  for (const sec of text.split(/\n(?=## )/)) {
    const m = sec.match(/^## (KRW-[A-Z0-9]+)/); if (!m) continue;
    if (/no data \(skipped/.test(sec)) continue;
    const c = sec.match(/\(([+-][\d.]+)% 24h\)/), mo = sec.match(/([+-][\d.]+)% over 20 sessions/);
    out.push({ market: m[1], chg24hPct: c ? Number(c[1]) : null, mom20Pct: mo ? Number(mo[1]) : null });
  }
  return out;
}

const PUMP = /\b(surge|surges|surged|surging|jump|jumps|jumped|rally|rallies|rallied|soar|soars|soared|skyrocket|skyrockets|breakout|breaks out|explode|explodes|pump|pumps)\b/i;
/** 뉴스 보고서의 한 코인 섹션에서 "급등을 묘사하는" 헤드라인 비율 — 이미 일어난 펌핑의 후행 보도 */
export function pumpHeadlineShare(newsText: string, market: string): { headlines: number; pump: number; share: number } {
  const sec = newsText.split(/\n(?=## )/).find((s) => s.startsWith(`## ${market}`));
  if (!sec) return { headlines: 0, pump: 0, share: 0 };
  const lines = sec.split("\n").filter((l) => /^\s*·\s*\[(BULLISH|BEARISH|NEUTRAL)/.test(l));
  const pump = lines.filter((l) => PUMP.test(l)).length;
  return { headlines: lines.length, pump, share: lines.length ? +(pump / lines.length).toFixed(2) : 0 };
}

/** t값 → 확신도. 0.3 + 0.3·t, [0.1, 0.9] 클램프 */
export function confidenceFromT(t: number): number { return +Math.max(0.1, Math.min(0.9, 0.3 + 0.3 * t)).toFixed(2); }

export function officeConfidence(p: { positions: Array<{ market: string; weightPct: number }>; edges: QuantEdge[]; flagged: boolean }): { confidence: number; basis: string[] } {
  const basis: string[] = [];
  if (!p.positions.length) { basis.push("no positions — cash is a decision, confidence 0.5"); return { confidence: 0.5, basis }; }
  let wsum = 0, acc = 0;
  for (const pos of p.positions) {
    const e = p.edges.find((x) => x.market === pos.market);
    const c = e ? confidenceFromT(e.t) : 0.3;
    basis.push(`${pos.market.replace("KRW-", "")}: ${e ? `μ̂ ${e.muPctD}%/d σ̂ ${e.sigmaPctD}%/d n=${e.n} → t ${e.t}` : "no quant edge measured"} → ${c}`);
    acc += c * pos.weightPct; wsum += pos.weightPct;
  }
  let confidence = wsum > 0 ? acc / wsum : 0.3;
  if (p.flagged) { confidence *= 0.7; basis.push("a review round was exhausted with objections standing → ×0.7"); }
  confidence = +Math.max(0.1, Math.min(0.9, confidence)).toFixed(2);
  basis.push(`weighted confidence ${confidence}`);
  return { confidence, basis };
}
