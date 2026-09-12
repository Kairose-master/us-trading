import { upbit, type UpbitAccount, type UpbitOrderState, type UpbitTransfer } from "./upbit.js";
import { riskManager } from "../risk/riskManager.js";
import { logger } from "../core/logger.js";

/**
 * 실주문 집행 — Upbit 실계좌를 타깃 비중으로 맞춘다.
 *
 * 돈이 나가는 유일한 경로. 데스크가 거래 모드를 real로 바꿨을 때만
 * desk.rotateTo가 여기로 온다. 순서와 안전장치:
 *   1) 계획(planRotation, 순수 함수): 타깃에 없는 보유 전량 매도 → 타깃 대비
 *      차이가 최소주문(₩5,000) 이상인 것만 증감. 주문당 상한(maxOrderKrw) 클램프.
 *   2) 킬스위치·키·회전당 주문 수 상한 점검.
 *   3) 매도 먼저(시장가, 수량) → 계좌 재동기화 → 매수(시장가, KRW 금액, 가용 현금 클램프).
 *   4) 주문마다 체결을 uuid로 확인해 실제 체결가·수수료를 기록한다 — 추정치를 적지 않는다.
 * 부분 실패는 해당 주문만 skipped로 남기고 나머지는 계속한다 (한 종목 실패로 리밸런스 전체를
 * 버리면 포지션이 더 어긋난다).
 */

export const MIN_ORDER_KRW = 5_000;
/** 회전 한 번에 내보낼 수 있는 최대 주문 수 — 정책이 미쳐 날뛰어도 계좌를 한 번에 뒤집지 못하게 */
export const MAX_ORDERS_PER_ROTATION = 12;
const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_POLL_MS = 500;

export interface LivePosition { qty: number; avgKrw: number; lockedQty: number }
export interface LiveAccount {
  cashKrw: number;
  lockedKrw: number;
  positions: Map<string, LivePosition>; // 심볼("BTC") 키
  syncedAt: string;
}

export interface PlannedOrder {
  market: string;
  side: "buy" | "sell";
  /** 매수: 주문 KRW 금액 · 매도: 추정 KRW 가치 (기록용) */
  amountKrw: number;
  /** 매도 수량 (매수는 0 — 시장가 매수는 금액으로 나간다) */
  volume: number;
  note: string;
}

export interface LiveFill {
  uuid: string;
  market: string;
  side: "buy" | "sell";
  volume: number;
  priceKrw: number;
  amountKrw: number;
  feeKrw: number;
  state: UpbitOrderState["state"];
  ts: string;
}

const COIN_OF = (market: string) => market.split("-")[1];

/** Upbit accounts → 데스크 장부 형태. KRW 마켓 코인만, 잔고 0은 버린다 */
export function toLiveAccount(rows: UpbitAccount[], now = new Date().toISOString()): LiveAccount {
  let cashKrw = 0, lockedKrw = 0;
  const positions = new Map<string, LivePosition>();
  for (const r of rows) {
    const bal = Number(r.balance) || 0, locked = Number(r.locked) || 0;
    if (r.currency === "KRW") { cashKrw = bal; lockedKrw = locked; continue; }
    if (r.unit_currency && r.unit_currency !== "KRW") continue;
    if (bal + locked <= 0) continue;
    positions.set(r.currency, { qty: bal + locked, lockedQty: locked, avgKrw: Number(r.avg_buy_price) || 0 });
  }
  return { cashKrw, lockedKrw, positions, syncedAt: now };
}

export function liveEquityKrw(acct: LiveAccount, price: (market: string) => number): number {
  let eq = acct.cashKrw + acct.lockedKrw;
  for (const [sym, p] of acct.positions) {
    const px = price(`KRW-${sym}`);
    if (px > 0) eq += p.qty * px;
  }
  return eq;
}

/** 실모드 시작 이후 KRW 입출금 한 건 — 손익·드로다운 기준을 옮기는 외부 현금흐름 */
export interface LiveFlowRow { ts: string; krw: number; type: "deposit" | "withdraw"; uuid: string }
export interface LiveFlow {
  /** 입금 합(수수료 차감) */
  depositKrw: number;
  /** 출금 합(수수료 포함 — 계좌에서 실제로 빠진 금액) */
  withdrawKrw: number;
  /** 입금 − 출금. 손익 = 에쿼티 − (시작 에쿼티 + netKrw) */
  netKrw: number;
  /** 시간 오름차순 */
  rows: LiveFlowRow[];
  syncedAt: string;
}

/** 완료된 이체만 — 대기·취소·환불은 아직 돈이 안 움직였거나 되돌아왔다 */
const FLOW_DONE_STATE: Record<UpbitTransfer["type"], string> = { deposit: "ACCEPTED", withdraw: "DONE" };

/**
 * 입출금 내역 → 실모드 시작 이후 KRW 순유입. 순수 함수.
 * 출금은 손실이 아니고 입금은 수익이 아니다 — 실측: ₩523,998 출금이 "실모드 시작 이후 손익 −₩523,998"로 찍혔다.
 * 코인 입출금은 세지 않는다(그 시점 시세로 환산해야 해서 별도 과제).
 */
export function netKrwFlow(rows: UpbitTransfer[], sinceIso: string, now = new Date().toISOString()): LiveFlow {
  const since = Date.parse(sinceIso);
  const out: LiveFlowRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.currency !== "KRW" || r.state !== FLOW_DONE_STATE[r.type]) continue;
    const ts = r.done_at ?? r.created_at;
    const t = Date.parse(ts);
    if (!Number.isFinite(t) || t < since) continue;
    const key = `${r.type}:${r.uuid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const amount = Number(r.amount) || 0, fee = Number(r.fee) || 0;
    out.push({ ts: new Date(t).toISOString(), krw: r.type === "deposit" ? amount - fee : -(amount + fee), type: r.type, uuid: r.uuid });
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  let depositKrw = 0, withdrawKrw = 0;
  for (const f of out) { if (f.krw > 0) depositKrw += f.krw; else withdrawKrw -= f.krw; }
  return { depositKrw, withdrawKrw, netKrw: depositKrw - withdrawKrw, rows: out, syncedAt: now };
}

/** 특정 시점까지 누적된 순유입 — 에쿼티 스냅샷을 입출금 보정할 때 (드로다운은 보정 에쿼티로 잰다) */
export function flowUntil(flow: LiveFlow | null, tsIso: string): number {
  if (!flow) return 0;
  let sum = 0;
  for (const f of flow.rows) { if (f.ts <= tsIso) sum += f.krw; }
  return sum;
}

/**
 * 순수 계획 — 현재 계좌 + 가격 + 타깃 비중 → 주문 목록. 네트워크 없음.
 * 페이퍼 rotateTo와 같은 규칙(타깃 밖 전량 매도, ₩5,000 미만 차이 무시)에
 * 주문당 상한과 가용 현금 클램프를 더했다.
 */
export function planRotation(p: {
  account: LiveAccount;
  prices: Map<string, number>;
  targets: Array<{ market: string; weightPct: number }>;
  maxOrderKrw: number;
  feePct?: number;
}): { orders: PlannedOrder[]; skipped: string[]; equityKrw: number } {
  const fee = (p.feePct ?? 0.05) / 100;
  const price = (m: string) => p.prices.get(m) ?? 0;
  const equity = liveEquityKrw(p.account, price);
  const orders: PlannedOrder[] = [];
  const skipped: string[] = [];
  let cash = p.account.cashKrw; // 가용 현금만 — locked는 미체결에 묶여 있어 못 쓴다
  const targetOf = new Map(p.targets.map((t) => [t.market, t.weightPct]));

  const sell = (market: string, qty: number, note: string) => {
    if (qty <= 0) return; // 전부 미체결에 묶여 있음
    const px = price(market);
    if (px <= 0) { skipped.push(`${market}: 현재가 없음 — 보유 유지`); return; }
    const value = qty * px;
    if (value < MIN_ORDER_KRW) { skipped.push(`${market}: ₩${Math.round(value).toLocaleString()} < 최소주문 — 먼지 보유 유지`); return; }
    orders.push({ market, side: "sell", volume: +qty.toFixed(8), amountKrw: Math.round(value), note });
    cash += value * (1 - fee);
  };

  // 1) 타깃에 없는 보유분 전량 매도 (미체결에 묶인 수량은 뺀다)
  for (const [sym, pos] of p.account.positions) {
    const market = `KRW-${sym}`;
    if (targetOf.has(market)) continue;
    const free = pos.qty - pos.lockedQty;
    if (free > 0) sell(market, free, "타깃 제외 — 전량 매도");
  }
  // 2) 타깃 비중으로 증감
  const buys: PlannedOrder[] = [];
  for (const t of p.targets) {
    const sym = COIN_OF(t.market);
    const px = price(t.market);
    if (px <= 0) { skipped.push(`${t.market}: 현재가 없음`); continue; }
    const pos = p.account.positions.get(sym);
    const cur = (pos?.qty ?? 0) * px;
    const want = (t.weightPct / 100) * equity;
    const diff = want - cur;
    if (Math.abs(diff) < MIN_ORDER_KRW) continue;
    if (diff < 0) {
      const free = (pos?.qty ?? 0) - (pos?.lockedQty ?? 0);
      sell(t.market, Math.min(free, -diff / px), `비중 ${t.weightPct}% 로 축소`);
    } else {
      const amt = Math.min(diff, p.maxOrderKrw);
      buys.push({ market: t.market, side: "buy", volume: 0, amountKrw: Math.floor(amt), note: amt < diff ? `비중 ${t.weightPct}% 로 확대 (주문당 상한 ₩${p.maxOrderKrw.toLocaleString()} 클램프)` : `비중 ${t.weightPct}% 로 확대` });
    }
  }
  // 3) 매수는 매도 뒤 가용 현금 안에서 — 큰 것부터, 모자라면 마지막 것을 줄인다
  buys.sort((a, b) => b.amountKrw - a.amountKrw);
  for (const b of buys) {
    const avail = Math.floor(cash / (1 + fee));
    if (avail < MIN_ORDER_KRW) { skipped.push(`${b.market}: 현금 부족 (가용 ₩${Math.max(0, avail).toLocaleString()})`); continue; }
    if (b.amountKrw > avail) { b.note += ` · 현금 한도로 ₩${avail.toLocaleString()}`; b.amountKrw = avail; }
    orders.push(b);
    cash -= b.amountKrw * (1 + fee);
  }
  return { orders, skipped, equityKrw: equity };
}

function fillOf(o: UpbitOrderState, ts: string): LiveFill {
  const vol = Number(o.executed_volume) || 0;
  let funds = 0;
  if (o.trades?.length) for (const t of o.trades) funds += Number(t.funds) || Number(t.price) * Number(t.volume) || 0;
  else if (o.side === "bid" && o.ord_type === "price" && o.state === "done") funds = Number(o.price) || 0; // 시장가 매수: price=주문 금액
  const fee = Number(o.paid_fee) || 0;
  return { uuid: o.uuid, market: o.market, side: o.side === "bid" ? "buy" : "sell", volume: vol, priceKrw: vol > 0 && funds > 0 ? funds / vol : Number(o.price) || 0, amountKrw: funds, feeKrw: fee, state: o.state, ts };
}

/** 주문이 done/cancel이 될 때까지 폴링 — 시장가라 보통 1초 안. 시간 초과면 마지막 상태를 그대로 돌려준다 */
async function settle(uuid: string): Promise<UpbitOrderState> {
  const until = Date.now() + SETTLE_TIMEOUT_MS;
  let last: UpbitOrderState | null = null;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    last = await upbit.order(uuid);
    if (last.state === "done" || last.state === "cancel") return last;
  }
  logger.warn("[live] 체결 확인 시간 초과 — 마지막 상태로 기록", { uuid, state: last?.state });
  return last ?? (await upbit.order(uuid));
}

export const live = {
  async sync(): Promise<LiveAccount> {
    return toLiveAccount(await upbit.accounts());
  },

  /** 실모드 시작(sinceIso) 이후 KRW 입출금 — 최신순 페이지를 since 이전 건이 나올 때까지 넘긴다 */
  async flows(sinceIso: string): Promise<LiveFlow> {
    const since = Date.parse(sinceIso);
    const rows: UpbitTransfer[] = [];
    for (const kind of ["deposits", "withdraws"] as const) {
      const type = kind === "deposits" ? "deposit" : "withdraw";
      for (let page = 1; page <= 10; page++) {
        const batch = await upbit.transfers(kind, { currency: "KRW", state: FLOW_DONE_STATE[type], page, limit: 100 });
        for (const r of batch) rows.push({ ...r, type });
        const oldest = batch.length ? Date.parse(batch[batch.length - 1].done_at ?? batch[batch.length - 1].created_at) : NaN;
        if (batch.length < 100 || (Number.isFinite(oldest) && oldest < since)) break;
      }
    }
    return netKrwFlow(rows, sinceIso);
  },

  /** 집행 전 관문 — 통과 못 하면 사유 */
  gate(planned: number): string | null {
    if (riskManager.killSwitchActive) return "킬스위치 활성 — 실주문 전면 차단";
    if (!upbit.hasKeys()) return "Upbit 키 없음";
    if (planned > MAX_ORDERS_PER_ROTATION) return `계획 주문 ${planned}건 > 회전당 상한 ${MAX_ORDERS_PER_ROTATION} — 정책(maxPositions/maxTurnoverPct)을 줄이거나 나눠서 집행`;
    return null;
  },

  /**
   * 계획을 실제로 내보낸다. 매도 전부 → 재동기화 → 매수. 반환: 체결 목록 + 실패 사유.
   * 각 주문의 실패는 그 주문만 skipped로 남긴다.
   */
  async execute(plan: PlannedOrder[], opts: { reason: string; feePct?: number }): Promise<{ fills: LiveFill[]; skipped: string[]; account: LiveAccount | null }> {
    const fills: LiveFill[] = [];
    const skipped: string[] = [];
    const fee = (opts.feePct ?? 0.05) / 100;
    const tag = `cp-${Date.now().toString(36)}`;
    let n = 0;
    const send = async (o: PlannedOrder, amountKrw: number) => {
      const identifier = `${tag}-${++n}`;
      const req = o.side === "sell"
        ? { market: o.market, side: "ask" as const, ord_type: "market" as const, volume: o.volume.toFixed(8), identifier }
        : { market: o.market, side: "bid" as const, ord_type: "price" as const, price: String(Math.floor(amountKrw)), identifier };
      logger.warn("[live] 주문 전송", { ...req, note: o.note, reason: opts.reason });
      const placed = await upbit.placeOrder(req);
      const done = placed.state === "done" || placed.state === "cancel" ? placed : await settle(placed.uuid);
      const f = fillOf(done, new Date().toISOString());
      logger.warn("[live] 체결", { uuid: f.uuid, market: f.market, side: f.side, volume: f.volume, priceKrw: Math.round(f.priceKrw), amountKrw: Math.round(f.amountKrw), feeKrw: f.feeKrw, state: f.state });
      if (f.volume <= 0) skipped.push(`${o.market}: 주문 ${f.uuid} 미체결 (${f.state})`);
      else fills.push(f);
    };

    for (const o of plan.filter((x) => x.side === "sell")) {
      try { await send(o, o.amountKrw); } catch (e) { skipped.push(`${o.market} 매도 실패: ${(e as Error).message}`); logger.error("[live] 매도 실패", { market: o.market, error: (e as Error).message }); }
    }
    let account: LiveAccount | null = null;
    const buys = plan.filter((x) => x.side === "buy");
    if (buys.length) {
      try { account = await this.sync(); } catch (e) { skipped.push(`계좌 재동기화 실패 — 매수 ${buys.length}건 보류: ${(e as Error).message}`); return { fills, skipped, account }; }
      let cash = account.cashKrw;
      for (const o of buys) {
        const avail = Math.floor(cash / (1 + fee));
        const amt = Math.min(o.amountKrw, avail);
        if (amt < MIN_ORDER_KRW) { skipped.push(`${o.market}: 현금 부족 (가용 ₩${Math.max(0, avail).toLocaleString()})`); continue; }
        try { await send(o, amt); cash -= amt * (1 + fee); } catch (e) { skipped.push(`${o.market} 매수 실패: ${(e as Error).message}`); logger.error("[live] 매수 실패", { market: o.market, error: (e as Error).message }); }
      }
    }
    try { account = await this.sync(); } catch (e) { skipped.push(`집행 후 계좌 동기화 실패: ${(e as Error).message}`); }
    return { fills, skipped, account };
  },
};
