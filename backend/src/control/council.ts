/**
 * 매니지먼트 협의회 — 대시보드 기능마다 총괄 매니저 에이전트 하나. 중재기가 가중평균으로
 * 섞던 것을 끝내고, 매니저들이 시장별로 입장을 내고(SUPPORT / OPPOSE / ABSTAIN), 반대가
 * 나오면 수정 라운드를 거쳐, 정족수를 채운 시장만 최종 결정에 오른다.
 *
 * 매니저:
 *   scanner   알트 스캐너 총괄 — 위험조정 모멘텀 로테이션 제안
 *   office    증권 오피스 총괄 — 9역할 협의의 위원장 결정
 *   evolution 진화 총괄       — 본 적 없는 60일 시험을 통과한 스쿼드의 타깃
 *   signals   파이프라인 신호 총괄 — 앙상블 알파. **혼자서는 매수를 통과시킬 수 없다** (정족수에 제안 매니저 2명, 신호는 그중 하나일 뿐)
 *   sentiment 센티먼트 총괄   — 제안 없음. 헤드라인 감성이 BEARISH면 OPPOSE, BULLISH면 SUPPORT(기울기)
 *   risk      리스크 총괄     — 제안 없음. 거부권: 킬스위치, 페이퍼 드로다운, 종목 상한·총노출·현금 하한. 정책의 집행자
 *
 * 전부 결정적 규칙이다. 각 입장에는 그 매니저가 실제로 읽은 숫자가 이유로 붙는다 — 지어내는 문장이 없다.
 * 이 파일은 순수 함수만 둔다 (테스트 가능). I/O는 plane.ts가 한다.
 */

export type ManagerId = "scanner" | "office" | "evolution" | "signals" | "sentiment" | "risk";
export type Stance = "SUPPORT" | "OPPOSE" | "ABSTAIN" | "VETO";

export interface Target { market: string; weightPct: number }
export interface CouncilProposal { manager: ManagerId; targets: Target[]; confidence: number; evidence: string; ageMin: number }
export interface SentimentRead { market: string; score: number; label: "BULLISH" | "BEARISH" | "NEUTRAL"; mentions: number; driver: string | null }
export interface RiskContext {
  killSwitch: boolean;
  /** 페이퍼 장부 드로다운(%) — 시드 대비 고점에서 얼마나 내려왔나 */
  drawdownPct: number;
  policy: { maxWeightPct: number; maxPositions: number; cashFloorPct: number; grossMaxPct: number };
  holdings: Target[];
}
export interface ManagerStanding { id: ManagerId; name: string; nameKo: string; weight: number; enabled: boolean }

export interface Position { manager: ManagerId; market: string; stance: Stance; weightPct: number | null; reason: string }
export interface CouncilRound { round: number; title: string; positions: Position[]; notes: string[] }
export interface CouncilResult {
  targets: Target[];
  cashPct: number;
  rounds: CouncilRound[];
  /** 시장별 최종 표: 지지 매니저, 반대 매니저, 결과 */
  tally: Array<{ market: string; supporters: ManagerId[]; opposers: ManagerId[]; vetoed: boolean; outcome: "ADOPTED" | "REJECTED" | "WITHDRAWN"; weightPct: number; why: string }>;
  summary: string[];
  constraints: string[];
  /** 의결 정족수를 채운 시장이 하나라도 있었나 */
  quorumMet: boolean;
}

export const MANAGERS: Array<{ id: ManagerId; name: string; nameKo: string; proposes: boolean; description: string }> = [
  { id: "scanner", name: "Scanner Manager", nameKo: "알트 스캐너 총괄", proposes: true, description: "HMM 강세·모멘텀/변동성 랭킹의 로테이션 타깃을 낸다" },
  { id: "office", name: "Office Manager", nameKo: "증권 오피스 총괄", proposes: true, description: "9역할 협의를 거친 위원장 결정을 가져온다" },
  { id: "evolution", name: "Evolution Manager", nameKo: "진화 총괄", proposes: true, description: "본 적 없는 60일 시험을 살아남은 스쿼드의 타깃을 낸다" },
  { id: "signals", name: "Signals Manager", nameKo: "파이프라인 신호 총괄", proposes: true, description: "앙상블 알파의 타깃. 혼자서는 매수를 통과시킬 수 없다" },
  { id: "sentiment", name: "Sentiment Manager", nameKo: "센티먼트 총괄", proposes: false, description: "실제 헤드라인 감성으로 지지·반대" },
  { id: "risk", name: "Risk Manager", nameKo: "리스크 총괄", proposes: false, description: "거부권 — 킬스위치·드로다운·정책 한도" },
];

const PROPOSERS: ManagerId[] = ["scanner", "office", "evolution", "signals"];
const QUORUM = 2; // 서로 다른 제안 매니저 2명 이상이 지지해야 채택
const DRAWDOWN_HALF_PCT = 8; // 페이퍼 드로다운이 이 이상이면 리스크 총괄이 총노출 절반 요구
const DRAWDOWN_VETO_PCT = 15; // 이 이상이면 신규 매수 전면 거부 (현금)
const sym = (m: string) => m.replace("KRW-", "");

export function convene(p: {
  proposals: CouncilProposal[];
  standing: ManagerStanding[];
  sentiment: SentimentRead[];
  risk: RiskContext;
}): CouncilResult {
  const rounds: CouncilRound[] = [];
  const constraints: string[] = [];
  const standingOf = (id: ManagerId) => p.standing.find((s) => s.id === id);
  const active = p.proposals.filter((x) => standingOf(x.manager)?.enabled !== false && PROPOSERS.includes(x.manager));
  const markets = [...new Set(active.flatMap((x) => x.targets.filter((t) => t.weightPct > 0).map((t) => t.market)))];

  // ── Round 1: 입장 표명 ─────────────────────────────────────────────────────
  const r1: Position[] = [];
  for (const m of markets) {
    for (const pr of active) {
      const t = pr.targets.find((x) => x.market === m);
      if (t && t.weightPct > 0) r1.push({ manager: pr.manager, market: m, stance: "SUPPORT", weightPct: t.weightPct, reason: `${t.weightPct}% — conf ${pr.confidence.toFixed(2)}, ${pr.ageMin < 1 ? "just now" : `${Math.round(pr.ageMin)}m ago`} · ${pr.evidence.slice(0, 90)}` });
      else if (pr.targets.some((x) => x.weightPct > 0)) r1.push({ manager: pr.manager, market: m, stance: "ABSTAIN", weightPct: null, reason: "not in my targets" });
    }
    const s = p.sentiment.find((x) => x.market === m);
    if (s && s.mentions > 0) {
      if (s.label === "BEARISH") r1.push({ manager: "sentiment", market: m, stance: "OPPOSE", weightPct: null, reason: `headlines BEARISH ${s.score.toFixed(2)} over ${s.mentions} mentions${s.driver ? ` — "${s.driver.slice(0, 60)}"` : ""}` });
      else if (s.label === "BULLISH") r1.push({ manager: "sentiment", market: m, stance: "SUPPORT", weightPct: null, reason: `headlines BULLISH +${s.score.toFixed(2)} over ${s.mentions} mentions` });
      else r1.push({ manager: "sentiment", market: m, stance: "ABSTAIN", weightPct: null, reason: `headlines NEUTRAL ${s.score.toFixed(2)} (${s.mentions})` });
    } else r1.push({ manager: "sentiment", market: m, stance: "ABSTAIN", weightPct: null, reason: "no headlines tracked for this market" });
  }
  const r1notes: string[] = [];
  if (p.risk.killSwitch) { for (const m of markets) r1.push({ manager: "risk", market: m, stance: "VETO", weightPct: null, reason: "kill switch active" }); r1notes.push("risk: kill switch — no new exposure"); }
  else if (p.risk.drawdownPct >= DRAWDOWN_VETO_PCT) { for (const m of markets) r1.push({ manager: "risk", market: m, stance: "VETO", weightPct: null, reason: `paper drawdown ${p.risk.drawdownPct.toFixed(1)}% ≥ ${DRAWDOWN_VETO_PCT}% — go to cash` }); r1notes.push(`risk: drawdown ${p.risk.drawdownPct.toFixed(1)}% — veto on all new positions`); }
  else if (p.risk.drawdownPct >= DRAWDOWN_HALF_PCT) r1notes.push(`risk: drawdown ${p.risk.drawdownPct.toFixed(1)}% ≥ ${DRAWDOWN_HALF_PCT}% — will halve gross exposure`);
  else r1notes.push(`risk: drawdown ${p.risk.drawdownPct.toFixed(1)}% — within tolerance`);
  if (active.length === 0) r1notes.push("no proposing manager has a live proposal");
  rounds.push({ round: 1, title: "입장 표명", positions: r1, notes: r1notes });

  // ── Round 2: 반대에 대한 수정 ────────────────────────────────────────────────
  const r2: Position[] = [];
  const r2notes: string[] = [];
  const support = new Map<string, Array<{ manager: ManagerId; weightPct: number; stance: Stance }>>();
  for (const m of markets) {
    const sup = r1.filter((x) => x.market === m && x.stance === "SUPPORT" && PROPOSERS.includes(x.manager) && x.weightPct !== null);
    const opp = r1.filter((x) => x.market === m && x.stance === "OPPOSE");
    const veto = r1.some((x) => x.market === m && x.stance === "VETO");
    const list: Array<{ manager: ManagerId; weightPct: number; stance: Stance }> = [];
    for (const s of sup) {
      if (veto) { r2.push({ manager: s.manager, market: m, stance: "ABSTAIN", weightPct: null, reason: "withdrawn — risk veto" }); continue; }
      if (opp.length) {
        // 반대(센티먼트 BEARISH)를 받은 지지자는 절반으로 물러선다. 다른 제안 매니저도 지지하면 유지, 혼자면 철회
        const others = sup.filter((x) => x.manager !== s.manager).length;
        if (others === 0) { r2.push({ manager: s.manager, market: m, stance: "ABSTAIN", weightPct: null, reason: `withdrawn — opposed by ${opp.map((o) => o.manager).join("+")} and no other proposer supports` }); continue; }
        const w = +(s.weightPct! / 2).toFixed(2);
        r2.push({ manager: s.manager, market: m, stance: "SUPPORT", weightPct: w, reason: `halved to ${w}% after ${opp.map((o) => o.manager).join("+")} objection (${others} other proposer${others > 1 ? "s" : ""} still support)` });
        list.push({ manager: s.manager, weightPct: w, stance: "SUPPORT" });
        continue;
      }
      r2.push({ manager: s.manager, market: m, stance: "SUPPORT", weightPct: s.weightPct, reason: "position stands" });
      list.push({ manager: s.manager, weightPct: s.weightPct!, stance: "SUPPORT" });
    }
    support.set(m, list);
  }
  rounds.push({ round: 2, title: "반대에 대한 수정", positions: r2, notes: r2notes });

  // ── Round 3: 표결 — 정족수(제안 매니저 2명) + 리스크 거부권 없음 ─────────────
  const tally: CouncilResult["tally"] = [];
  const adopted: Target[] = [];
  for (const m of markets) {
    const list = support.get(m) ?? [];
    const supporters = [...new Set(list.map((x) => x.manager))];
    const opposers = [...new Set(r1.filter((x) => x.market === m && (x.stance === "OPPOSE" || x.stance === "VETO")).map((x) => x.manager))];
    const vetoed = r1.some((x) => x.market === m && x.stance === "VETO");
    const sentimentSupports = r1.some((x) => x.market === m && x.manager === "sentiment" && x.stance === "SUPPORT");
    if (vetoed) { tally.push({ market: m, supporters, opposers, vetoed, outcome: "REJECTED", weightPct: 0, why: "risk veto" }); continue; }
    if (supporters.length === 0) { tally.push({ market: m, supporters, opposers, vetoed, outcome: "WITHDRAWN", weightPct: 0, why: "no proposer left supporting" }); continue; }
    const onlySignals = supporters.length === 1 && supporters[0] === "signals";
    if (supporters.length < QUORUM) {
      tally.push({ market: m, supporters, opposers, vetoed, outcome: "REJECTED", weightPct: 0, why: onlySignals ? "signals alone cannot buy — needs a second proposing manager" : `only ${supporters[0]} supports — quorum is ${QUORUM} proposing managers${sentimentSupports ? " (sentiment support does not count toward quorum)" : ""}` });
      continue;
    }
    // 채택 비중 = 지지 매니저들의 standing 가중 평균 × 합의 비율(지지자 수 / 제안 매니저 수). 센티먼트 지지는 +10% 기울기
    const wsum = list.reduce((a, x) => a + (standingOf(x.manager)?.weight ?? 1), 0) || 1;
    let w = list.reduce((a, x) => a + x.weightPct * (standingOf(x.manager)?.weight ?? 1), 0) / wsum;
    const agreement = supporters.length / Math.max(1, active.length);
    w *= 0.6 + 0.4 * agreement;
    if (sentimentSupports) w *= 1.1;
    w = +w.toFixed(2);
    adopted.push({ market: m, weightPct: w });
    tally.push({ market: m, supporters, opposers, vetoed, outcome: "ADOPTED", weightPct: w, why: `${supporters.join("+")} agree (${supporters.length}/${active.length} proposers)${sentimentSupports ? ", sentiment concurs" : ""}${opposers.length ? `; over ${opposers.join("+")} objection` : ""}` });
  }

  // ── 리스크 총괄의 정책 집행 (한도는 협의 대상이 아니다) ───────────────────────
  let targets = adopted.sort((a, b) => b.weightPct - a.weightPct);
  const pol = p.risk.policy;
  for (const t of targets) if (t.weightPct > pol.maxWeightPct) { constraints.push(`risk: ${sym(t.market)} ${t.weightPct}% → cap ${pol.maxWeightPct}%`); t.weightPct = pol.maxWeightPct; }
  if (targets.length > pol.maxPositions) { constraints.push(`risk: ${targets.length} positions → max ${pol.maxPositions} (dropped ${targets.slice(pol.maxPositions).map((t) => sym(t.market)).join(",")})`); targets = targets.slice(0, pol.maxPositions); }
  let gross = targets.reduce((a, t) => a + t.weightPct, 0);
  let grossMax = Math.min(pol.grossMaxPct, 100 - pol.cashFloorPct);
  if (!p.risk.killSwitch && p.risk.drawdownPct >= DRAWDOWN_HALF_PCT && p.risk.drawdownPct < DRAWDOWN_VETO_PCT) grossMax = Math.min(grossMax, grossMax / 2);
  if (gross > grossMax) { const k = grossMax / gross; constraints.push(`risk: gross ${gross.toFixed(1)}% → ${grossMax.toFixed(1)}% (×${k.toFixed(2)})`); targets = targets.map((t) => ({ ...t, weightPct: +(t.weightPct * k).toFixed(2) })); gross = targets.reduce((a, t) => a + t.weightPct, 0); }
  const r3notes = [...tally.map((t) => `${sym(t.market)}: ${t.outcome}${t.outcome === "ADOPTED" ? ` ${t.weightPct}%` : ""} — ${t.why}`), ...constraints];
  rounds.push({ round: 3, title: "표결 · 리스크 집행", positions: [], notes: r3notes });

  const quorumMet = tally.some((t) => t.outcome === "ADOPTED");
  const summary = [
    `${active.length} proposing manager(s) brought ${markets.length} market(s); ${tally.filter((t) => t.outcome === "ADOPTED").length} adopted, ${tally.filter((t) => t.outcome === "REJECTED").length} rejected, ${tally.filter((t) => t.outcome === "WITHDRAWN").length} withdrawn`,
    ...(quorumMet ? [] : markets.length ? ["no market reached quorum — the council holds cash"] : ["nothing proposed — cash"]),
  ];
  return { targets, cashPct: +(100 - gross).toFixed(2), rounds, tally, summary, constraints, quorumMet };
}
