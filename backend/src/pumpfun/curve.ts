/**
 * pump.fun 본딩커브 — 순수 수학. 가격은 호가창이 아니라 **가상 준비금**(x·y=k)에서 결정론적으로 나온다.
 * 그래서 페이퍼 체결은 "슬리피지 0.05% 가정"이 아니라 이 수식으로 정확히 계산한다 — 주문 크기가 준비금을
 * 얼마나 움직이는지가 곧 슬리피지다. 여기서 계산되지 않는 것은 지연(우리 트랜잭션이 실리기 전에 남이
 * 먼저 사는 것)뿐이고, 그건 ledger가 별도의 지연 슬리피지 가정으로 문다.
 *
 * 규약: sol은 SOL 단위, tokens는 토큰 단위(소수 6자리를 이미 나눈 값 — PumpPortal 이벤트와 같은 단위).
 */

export interface CurveState {
  /** 가상 토큰 준비금 (토큰 단위) */
  vTokens: number;
  /** 가상 SOL 준비금 (SOL 단위) */
  vSol: number;
  /** 실제 토큰 준비금 — 0이 되면 커브 완료(졸업) */
  rTokens?: number;
  rSol?: number;
  complete?: boolean;
}

/** 커브 위 수수료(프로토콜+creator 합) 1.25%, 졸업 후 PumpSwap 0.25% — 2026-09 공개 문서 기준 */
export const CURVE_FEE_PCT = 1.25;
export const AMM_FEE_PCT = 0.25;
/** 커브 완료에 필요한 실 SOL(약 85 SOL) — 진행률 표시용. 정확한 값은 계정의 rTokens==0 이 말한다 */
export const GRADUATION_SOL = 85;
export const INITIAL_V_SOL = 30;
export const INITIAL_V_TOKENS = 1_073_000_000;

/** 현재 한계 가격 (SOL/토큰) */
export function spotPrice(c: CurveState): number {
  return c.vTokens > 0 ? c.vSol / c.vTokens : 0;
}

/** 시가총액(SOL) — 총공급 10억 × 한계가 */
export function marketCapSol(c: CurveState, supply = 1_000_000_000): number {
  return spotPrice(c) * supply;
}

/** 커브 진행률 0~1 — 가상 SOL이 30에서 시작해 ~115(30+85)에서 완료 */
export function progress(c: CurveState): number {
  return Math.max(0, Math.min(1, (c.vSol - INITIAL_V_SOL) / GRADUATION_SOL));
}

export interface Fill {
  /** 받는(또는 내는) 토큰 */
  tokens: number;
  /** 낸(또는 받는) SOL — 수수료 차감 후 실제 지갑 변화 */
  sol: number;
  feeSol: number;
  /** 체결 평균가 SOL/토큰 (수수료 포함) */
  avgPrice: number;
  /** 한계가 대비 평균가 괴리 (%) — 크기에서 오는 슬리피지 */
  impactPct: number;
  next: CurveState;
}

/**
 * SOL을 내고 토큰을 산다. 수수료는 넣는 SOL에서 먼저 떼고, 남은 SOL이 준비금에 들어간다.
 * tokensOut = vTokens − k / (vSol + solIn)
 */
export function quoteBuy(c: CurveState, solIn: number, feePct = CURVE_FEE_PCT): Fill {
  if (!(solIn > 0) || !(c.vSol > 0) || !(c.vTokens > 0)) return { tokens: 0, sol: 0, feeSol: 0, avgPrice: 0, impactPct: 0, next: c };
  const feeSol = solIn * (feePct / 100);
  const net = solIn - feeSol;
  const k = c.vSol * c.vTokens;
  const newVSol = c.vSol + net;
  const newVTokens = k / newVSol;
  let tokens = c.vTokens - newVTokens;
  // 실제 토큰 준비금보다 많이 살 수는 없다 — 커브가 완료된다
  if (c.rTokens !== undefined && tokens > c.rTokens) tokens = c.rTokens;
  const spot = spotPrice(c);
  const avg = tokens > 0 ? solIn / tokens : 0;
  const next: CurveState = { ...c, vSol: newVSol, vTokens: c.vTokens - tokens, rTokens: c.rTokens !== undefined ? c.rTokens - tokens : undefined, rSol: c.rSol !== undefined ? c.rSol + net : undefined };
  if (next.rTokens !== undefined && next.rTokens <= 0) next.complete = true;
  return { tokens, sol: solIn, feeSol, avgPrice: avg, impactPct: spot > 0 ? +(((avg / spot) - 1) * 100).toFixed(4) : 0, next };
}

/**
 * 토큰을 팔고 SOL을 받는다. solOut(총) = vSol − k / (vTokens + tokensIn), 수수료는 받는 SOL에서 뗀다.
 */
export function quoteSell(c: CurveState, tokensIn: number, feePct = CURVE_FEE_PCT): Fill {
  if (!(tokensIn > 0) || !(c.vSol > 0) || !(c.vTokens > 0)) return { tokens: 0, sol: 0, feeSol: 0, avgPrice: 0, impactPct: 0, next: c };
  const k = c.vSol * c.vTokens;
  const newVTokens = c.vTokens + tokensIn;
  const newVSol = k / newVTokens;
  const gross = c.vSol - newVSol;
  const feeSol = gross * (feePct / 100);
  const sol = gross - feeSol;
  const spot = spotPrice(c);
  const avg = sol / tokensIn;
  const next: CurveState = { ...c, vSol: newVSol, vTokens: newVTokens, rTokens: c.rTokens !== undefined ? c.rTokens + tokensIn : undefined, rSol: c.rSol !== undefined ? Math.max(0, c.rSol - gross) : undefined };
  return { tokens: tokensIn, sol, feeSol, avgPrice: avg, impactPct: spot > 0 ? +(((avg / spot) - 1) * 100).toFixed(4) : 0, next };
}

/** 보유 토큰을 지금 전부 팔면 받을 SOL — 포지션 평가액은 한계가×수량이 아니라 이것이다 (큰 포지션일수록 차이가 크다) */
export function liquidationValue(c: CurveState, tokens: number, feePct = CURVE_FEE_PCT): number {
  return tokens > 0 ? quoteSell(c, tokens, feePct).sol : 0;
}

/**
 * 온체인 BondingCurve 계정 디코딩 (program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P).
 * 레이아웃(실물 계정으로 검증): 8B discriminator · u64 virtual_token · u64 virtual_sol · u64 real_token ·
 * u64 real_sol · u64 total_supply · bool complete. 토큰은 소수 6자리, SOL은 lamports.
 */
export function decodeCurveAccount(base64: string): CurveState & { supply: number } {
  const b = Buffer.from(base64, "base64");
  if (b.length < 49) throw new Error(`bonding curve account too short: ${b.length}B`);
  const u = (o: number) => Number(b.readBigUInt64LE(o));
  return { vTokens: u(8) / 1e6, vSol: u(16) / 1e9, rTokens: u(24) / 1e6, rSol: u(32) / 1e9, supply: u(40) / 1e6, complete: b[48] === 1 };
}
