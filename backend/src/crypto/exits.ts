/**
 * 포지션 청산 규칙 — 협의회와 별개로 "적절한 때에 파는" 로직.
 *
 * 협의회 회전은 60분 간격·회전율 8% 하한·엣지 게이트·30시간 제안 TTL에 묶여 있어
 * 손절이 늦고 작은 포지션은 영영 안 팔린다. 이 모듈은 데스크가 시세 폴링마다 보유 종목을
 * 검사해 조건에 걸리면 즉시 시장가로 파는 규칙을 순수 함수로 정의한다. 실제 주문은
 * desk.checkExits가 낸다 (페이퍼 장부 또는 live.execute).
 *
 * 규칙(전부 평단·고점 기준, 설정 페이지에서 조정):
 *   stop   — 평단 대비 −stopLossPct 이하면 전량 매도
 *   trail  — 추적 시작 이후 고점 대비 −trailingStopPct 이하면 전량 매도
 *   take   — 평단 대비 +takeProfitPct 이상이면 takeProfitSellPct%만 매도 (포지션당 1회, 나머지는 trail이 지킨다)
 *   stale  — 어느 제안 매니저도 지지하지 않는 상태가 staleHours 이상 이어지면 전량 매도
 * 청산한 종목은 reentryCooldownMin 동안 회전 타깃에서 제외한다 (협의회가 바로 되사는 것을 막는다).
 */

export interface ExitRules {
  enabled: boolean;
  stopLossPct: number;
  trailingStopPct: number;
  takeProfitPct: number;
  takeProfitSellPct: number;
  staleHours: number;
  reentryCooldownMin: number;
}

export const DEFAULT_EXIT_RULES: ExitRules = {
  enabled: true,
  stopLossPct: 7,
  trailingStopPct: 10,
  takeProfitPct: 20,
  takeProfitSellPct: 50,
  staleHours: 24,
  reentryCooldownMin: 240,
};

/** 규칙 패치 검증 — 범위 밖이면 사유를 돌려주고 아무것도 바꾸지 않는다 */
export function validateExitRules(patch: Partial<ExitRules>): string | null {
  const num = (k: keyof ExitRules, lo: number, hi: number) => {
    const v = patch[k];
    if (v === undefined) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return `${k}: ${lo}~${hi} 사이 숫자여야 합니다`;
    return null;
  };
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") return "enabled: boolean";
  return num("stopLossPct", 0.5, 50) ?? num("trailingStopPct", 0.5, 50) ?? num("takeProfitPct", 1, 500) ?? num("takeProfitSellPct", 1, 100) ?? num("staleHours", 1, 720) ?? num("reentryCooldownMin", 0, 10_080);
}

/** 포지션별 추적 상태 — 고점·익절 여부·미지지 시작 시각. 장부와 별도로 영속 */
export interface ExitTrack {
  /** 추적 시작 이후 고점 (KRW) */
  highKrw: number;
  /** 추적 시작 시각 */
  since: string;
  /** 익절 1회 실행 여부 */
  tpTaken: boolean;
  /** 지지 제안이 사라진 시각 (지지 중이면 null) */
  unsupportedSince: string | null;
}

export type ExitKind = "stop" | "trail" | "take" | "stale";

export interface ExitAction {
  symbol: string;
  market: string;
  kind: ExitKind;
  /** 매도 비율 (0~100) */
  sellPct: number;
  /** 매도 수량 (가용 수량 × sellPct) */
  volume: number;
  curKrw: number;
  avgKrw: number;
  pnlPct: number;
  reason: string;
}

export interface ExitPosition {
  symbol: string;
  qty: number;
  /** 미체결 주문에 묶인 수량 — 팔 수 없다 */
  lockedQty?: number;
  avgKrw: number;
  curKrw: number;
}

export interface EvaluateInput {
  positions: ExitPosition[];
  tracks: Map<string, ExitTrack>;
  rules: ExitRules;
  /** 현재 어떤 제안 매니저라도 지지하는 마켓들. null이면 제안 정보가 없어 stale 규칙을 판단하지 않는다 */
  supportedMarkets: Set<string> | null;
  now?: number;
}

const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);

/**
 * 순수 평가 — 추적 상태를 갱신한 새 Map과 실행할 청산 목록을 돌려준다. 네트워크·부작용 없음.
 * 보유하지 않는 심볼의 추적은 버린다(다음 진입은 새 고점부터).
 */
export function evaluateExits(input: EvaluateInput): { actions: ExitAction[]; tracks: Map<string, ExitTrack> } {
  const now = input.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const r = input.rules;
  const tracks = new Map<string, ExitTrack>();
  const actions: ExitAction[] = [];
  for (const p of input.positions) {
    const avail = Math.max(0, p.qty - (p.lockedQty ?? 0));
    if (p.qty <= 0 || p.curKrw <= 0) continue;
    const prev = input.tracks.get(p.symbol);
    const t: ExitTrack = prev ? { ...prev, highKrw: Math.max(prev.highKrw, p.curKrw) } : { highKrw: p.curKrw, since: nowIso, tpTaken: false, unsupportedSince: null };
    const market = `KRW-${p.symbol}`;
    if (input.supportedMarkets) t.unsupportedSince = input.supportedMarkets.has(market) ? null : (t.unsupportedSince ?? nowIso);
    tracks.set(p.symbol, t);
    if (!r.enabled || avail <= 0) continue;
    const pnlPct = pct(p.curKrw, p.avgKrw);
    const fromHigh = pct(p.curKrw, t.highKrw);
    const base = { symbol: p.symbol, market, curKrw: p.curKrw, avgKrw: p.avgKrw, pnlPct: +pnlPct.toFixed(2) };
    const full = (kind: ExitKind, reason: string) => actions.push({ ...base, kind, sellPct: 100, volume: avail, reason });
    if (p.avgKrw > 0 && pnlPct <= -r.stopLossPct) { full("stop", `손절 — 평단 대비 ${pnlPct.toFixed(1)}% ≤ −${r.stopLossPct}%`); continue; }
    if (fromHigh <= -r.trailingStopPct) { full("trail", `트레일링 스탑 — 고점 ₩${Math.round(t.highKrw).toLocaleString()} 대비 ${fromHigh.toFixed(1)}% ≤ −${r.trailingStopPct}% (평단 대비 ${pnlPct.toFixed(1)}%)`); continue; }
    if (input.supportedMarkets && t.unsupportedSince && now - Date.parse(t.unsupportedSince) >= r.staleHours * 3600_000) { full("stale", `지지 소멸 — ${r.staleHours}시간 이상 어느 매니저도 지지하지 않음 (평단 대비 ${pnlPct.toFixed(1)}%)`); continue; }
    if (p.avgKrw > 0 && !t.tpTaken && pnlPct >= r.takeProfitPct) {
      const sellPct = Math.min(100, r.takeProfitSellPct);
      actions.push({ ...base, kind: "take", sellPct, volume: sellPct >= 100 ? avail : +(avail * (sellPct / 100)).toFixed(8), reason: `익절 — 평단 대비 +${pnlPct.toFixed(1)}% ≥ +${r.takeProfitPct}%, ${sellPct}% 매도` });
    }
  }
  return { actions, tracks };
}

/** 회전 타깃에서 재진입 금지 중인 마켓을 걷어낸다 — 보유 중이면 현재 비중으로 고정(팔지도 사지도 않음) */
export function applyCooldown(
  targets: Array<{ market: string; weightPct: number }>,
  cooldownUntil: Map<string, string>,
  currentWeightPct: (market: string) => number,
  now = Date.now(),
): { targets: Array<{ market: string; weightPct: number }>; notes: string[] } {
  const notes: string[] = [];
  const cooling = new Set<string>();
  for (const [sym, until] of cooldownUntil) if (Date.parse(until) > now) cooling.add(`KRW-${sym}`);
  if (!cooling.size) return { targets, notes };
  const out = targets.filter((t) => !cooling.has(t.market));
  for (const m of cooling) {
    const cur = currentWeightPct(m);
    const wanted = targets.find((t) => t.market === m);
    if (cur > 0) out.push({ market: m, weightPct: +cur.toFixed(2) });
    if (wanted || cur > 0) notes.push(`${m}: 청산 후 재진입 금지 중 — ${cur > 0 ? `현재 비중 ${cur.toFixed(1)}% 유지` : "매수 제외"}`);
  }
  return { targets: out, notes };
}
