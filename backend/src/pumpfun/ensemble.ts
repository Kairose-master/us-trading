import type { FlowRead, MomentumRead } from "./flow.js";
import type { CommunityRead } from "./community.js";

/**
 * 복합 결정 — 엔진 넷이 토큰마다 표를 내고, 가중합이 문턱을 넘으면 진입한다. 지갑 하나를 따라가지 않는다.
 *   flow      봇·랭킹 지갑의 순매수 흐름 (유료 스트림)          — "지금 돈이 어디로 가나"
 *   momentum  졸업 직후·커브 후반·시총/댓글 가속 (무료 스냅샷)  — "관심이 붙고 있나"
 *   copy      추종 지갑들의 매수 표 (standing 가중, 플립 방지 통과분) — "따라갈 만한 사람이 사나"
 *   community 소셜·댓글·creator·보안 (게이트 + 배수)           — "커뮤니티가 있나"
 * 엔진 가중치는 실현 결과로 움직인다 (제어 평면의 엔진 귀속과 같은 규칙).
 */

export type EngineId = "flow" | "momentum" | "copy" | "community";
export interface EngineWeights { flow: number; momentum: number; copy: number; community: number }
export const DEFAULT_ENGINE_WEIGHTS: EngineWeights = { flow: 1, momentum: 1, copy: 1, community: 1 };

export interface EnsemblePolicy {
  /** 진입 문턱 (0~100 합성 점수) */
  enterScore: number;
  /** 보유 중 이 아래로 내려가면 청산 */
  exitScore: number;
  /** 진입 기본 크기 (에쿼티 %) — 점수 비례로 곱해진다 */
  basePct: number;
  /** 흐름 반전 청산: 랭킹 지갑 순매도가 이 SOL 넘으면 */
  flowReversalSol: number;
  /** 모멘텀 페이드 청산: 5분 고점 대비 % */
  fadeFromPeakPct: number;
  /** 흐름 표본 최소 거래 수 — 이 아래면 flow 는 기권 */
  minFlowTrades: number;
}
export const DEFAULT_ENSEMBLE_POLICY: EnsemblePolicy = { enterScore: 65, exitScore: 35, basePct: 15, flowReversalSol: 0.5, fadeFromPeakPct: -25, minFlowTrades: 8 };

export interface Vote { engine: EngineId; score: number; abstain: boolean; why: string[] }
export interface EnsembleRead {
  mint: string;
  score: number;
  votes: Vote[];
  blocked: boolean;
  sizeMult: number;
  action: "enter" | "hold" | "exit" | "none";
  why: string;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

export function flowVote(f: FlowRead | null, p: EnsemblePolicy): Vote {
  if (!f || f.n300 < p.minFlowTrades) return { engine: "flow", score: 50, abstain: true, why: [f ? `only ${f.n300} trades in 5m` : "no stream"] };
  const why: string[] = []; let s = 50;
  const add = (d: number, w: string) => { s += d; why.push(`${d >= 0 ? "+" : ""}${d} ${w}`); };
  if (f.rankedNet60 > 0.3) add(20, `ranked wallets net +${f.rankedNet60} SOL/60s`); else if (f.rankedNet60 < -0.3) add(-25, `ranked wallets net ${f.rankedNet60} SOL/60s`);
  if (f.rankedBuyers60 >= 3 && f.rankedBuyers60 > f.rankedSellers60) add(15, `${f.rankedBuyers60} ranked buyers vs ${f.rankedSellers60} sellers`);
  if (f.netSol300 > 2) add(10, `all wallets net +${f.netSol300} SOL/5m`); else if (f.netSol300 < -2) add(-15, `all wallets net ${f.netSol300} SOL/5m`);
  if (f.uniqueBuyers300 >= 20) add(10, `${f.uniqueBuyers300} unique buyers/5m`);
  if (f.buySellRatio300 >= 2) add(5, `buy/sell ${f.buySellRatio300}`); else if (f.buySellRatio300 < 0.6) add(-10, `buy/sell ${f.buySellRatio300}`);
  return { engine: "flow", score: clamp(s), abstain: false, why };
}

export function momentumVote(m: MomentumRead | null): Vote {
  if (!m) return { engine: "momentum", score: 50, abstain: true, why: ["no snapshots"] };
  const why: string[] = []; let s = 50;
  const add = (d: number, w: string) => { s += d; why.push(`${d >= 0 ? "+" : ""}${d} ${w}`); };
  if (m.sinceMigrationMin !== null && m.sinceMigrationMin <= 30) add(15, `migrated ${m.sinceMigrationMin.toFixed(0)}m ago`);
  if (m.curveProgress !== null && m.curveProgress >= 0.6 && m.curveProgress < 0.95) add(10, `curve ${(m.curveProgress * 100).toFixed(0)}% — graduation zone`);
  if (m.mcap5mPct !== null) { if (m.mcap5mPct >= 30) add(15, `mcap +${m.mcap5mPct}%/5m`); else if (m.mcap5mPct >= 10) add(8, `mcap +${m.mcap5mPct}%/5m`); else if (m.mcap5mPct <= -20) add(-20, `mcap ${m.mcap5mPct}%/5m`); }
  if (m.replies5m !== null && m.replies5m >= 5) add(8, `+${m.replies5m} replies/5m`);
  if (m.isLive) add(8, "live stream");
  if (m.kothMinAgo !== null && m.kothMinAgo <= 15) add(8, `KOTH ${m.kothMinAgo.toFixed(0)}m ago`);
  if (m.fromPeak5mPct !== null && m.fromPeak5mPct <= -25) add(-15, `${m.fromPeak5mPct}% from 5m peak`);
  if (m.secondsSinceTrade > 180) add(-15, `no trade for ${(m.secondsSinceTrade / 60).toFixed(0)}m`);
  if (m.ageMin < 2) add(-15, "younger than 2 minutes — sniper zone");
  return { engine: "momentum", score: clamp(s), abstain: false, why };
}

/** 추종 지갑 표 — 최근 10분 내 매수(플립 방지 통과)한 지갑들의 standing 합 */
export function copyVote(buyers: Array<{ wallet: string; standing: number; minAgo: number }>, sellers: Array<{ wallet: string; standing: number; minAgo: number }>): Vote {
  if (!buyers.length && !sellers.length) return { engine: "copy", score: 50, abstain: true, why: ["no followed wallet activity"] };
  const b = buyers.reduce((a, x) => a + x.standing, 0), sl = sellers.reduce((a, x) => a + x.standing, 0);
  const s = clamp(50 + 40 * Math.tanh(b - sl));
  return { engine: "copy", score: +s.toFixed(1), abstain: false, why: [`${buyers.length} followed buying (standing ${b.toFixed(2)}) vs ${sellers.length} selling (${sl.toFixed(2)})`] };
}

export function communityVote(c: CommunityRead | null): Vote {
  if (!c || c.unknown) return { engine: "community", score: 50, abstain: true, why: ["unknown"] };
  return { engine: "community", score: c.score, abstain: false, why: c.reasons.slice(0, 4) };
}

export function ensemble(mint: string, votes: Vote[], w: EngineWeights, p: EnsemblePolicy, held: boolean, community: CommunityRead | null, flow: FlowRead | null, mom: MomentumRead | null, heldPnlPct = 0): EnsembleRead {
  const active = votes.filter((v) => !v.abstain);
  // 커뮤니티는 게이트·배수이지 진입 근거가 아니다 — 흐름·모멘텀·카피 중 둘 이상이 말해야 산다 (실측: "이주 직후 +15" 하나와 중립 커뮤니티로 진입이 났다)
  const core = active.filter((v) => v.engine !== "community");
  const totalW = active.reduce((a, v) => a + w[v.engine], 0);
  const score = totalW > 0 ? +(active.reduce((a, v) => a + w[v.engine] * v.score, 0) / totalW).toFixed(1) : 50;
  const blocked = !!community?.block;
  const sizeMult = blocked ? 0 : (community?.multiplier ?? 0.75) * clamp((score - p.enterScore) / (100 - p.enterScore) + 0.5, 0.5, 1.5);
  let action: EnsembleRead["action"] = "none"; let why = `score ${score} (${active.length}/${votes.length} engines)`;
  if (held) {
    if (flow && flow.rankedNet60 <= -p.flowReversalSol) { action = "exit"; why = `flow reversal: ranked net ${flow.rankedNet60} SOL/60s`; }
    // 승자는 흔들린다 — +100% 넘긴 로트는 페이드·점수 청산을 넓게 (되돌림 −40%, 점수 청산 없음). 흐름 반전(랭킹 지갑 순매도)만 남긴다
    else if (mom && mom.fromPeak5mPct !== null && mom.fromPeak5mPct <= (heldPnlPct >= 100 ? -40 : p.fadeFromPeakPct)) { action = "exit"; why = `momentum fade ${mom.fromPeak5mPct}% from 5m peak`; }
    else if (heldPnlPct < 100 && score < p.exitScore && core.length >= 2) { action = "exit"; why = `score ${score} < exit ${p.exitScore}`; }
    else action = "hold";
  } else if (!blocked && score >= p.enterScore && core.length >= 2) { action = "enter"; why = `score ${score} ≥ ${p.enterScore} with ${core.length} core engines`; }
  else if (!blocked && score >= p.enterScore) why = `score ${score} but only ${core.length} core engine — need 2 (flow/momentum/copy)`;
  return { mint, score, votes, blocked, sizeMult: +sizeMult.toFixed(2), action, why };
}

/** 엔진 귀속 — 진입에 표를 낸 엔진들이 실현 결과를 나눠 갖는다 (지수 가중, [0.2, 3]) */
export function attribute(w: EngineWeights, votes: Vote[], pnlPct: number, eta = 2): EngineWeights {
  const r = Math.max(-0.25, Math.min(0.25, pnlPct / 100));
  const next = { ...w };
  for (const v of votes) { if (v.abstain) continue; const lean = (v.score - 50) / 50; next[v.engine] = +Math.max(0.2, Math.min(3, next[v.engine] * Math.exp(eta * r * lean))).toFixed(3); }
  return next;
}
