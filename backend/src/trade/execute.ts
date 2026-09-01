import { state } from "../api/state.js";
import { riskManager } from "../risk/riskManager.js";
import { kisClient } from "../kis/client.js";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import type { Exchange, Order, OrderType, Session, Side } from "../kis/types.js";

/**
 * 주문 실행 공용 경로 — 수동 주문(routes), 자동매매(autoTrader), MCP 워커 툴이
 * 전부 이 함수를 지나간다. 리스크 관문은 여기서 단 한 번, 예외 없이.
 * MOCK_DATA: 주문 기록 + 시장가는 1초 뒤 모의 체결(포지션/현금 반영).
 * 실모드: kisClient.placeOrder.
 */

export interface ExecuteOrderInput {
  symbol: string;
  exch?: Exchange;
  side: Side;
  orderType: OrderType;
  qty: number;
  price?: number;
  session?: Session;
  /** 감사 로그용 — 누가 이 주문을 냈는가 ("manual" | "auto-trade" | "mcp") */
  source: string;
  reason?: string;
}

export type ExecuteOrderResult =
  | { ok: true; orderId: string; status: "accepted"; refPrice: number }
  | { ok: false; error: string; blockedBy: "risk" | "input" | "upstream" };

export async function executeOrder(p: ExecuteOrderInput): Promise<ExecuteOrderResult> {
  const symbol = p.symbol.toUpperCase();
  const quote = state.quotes.get(symbol);
  const refPrice = p.price ?? quote?.last ?? 0;
  if (refPrice <= 0) return { ok: false, error: "가격 정보 없음 — 지정가로 주문하세요", blockedBy: "input" };
  if (!Number.isInteger(p.qty) || p.qty <= 0)
    return { ok: false, error: "수량은 1주 이상의 정수여야 합니다", blockedBy: "input" };
  const amountUsd = refPrice * p.qty;

  // ---- 리스크 관문 (예외 없음) ----
  const holding = state.positions.find((pos) => pos.symbol === symbol);
  const totalValue = state.balance.totalEquityUsd - state.balance.cashUsd + amountUsd;
  const symbolValue = (holding ? holding.curPrice * holding.qty : 0) + (p.side === "buy" ? amountUsd : 0);
  const blocked = riskManager.check({
    amountUsd,
    side: p.side,
    resultingOpenPositions: state.positions.length + (p.side === "buy" && !holding ? 1 : 0),
    resultingSymbolWeightPct: totalValue > 0 ? (symbolValue / totalValue) * 100 : 0,
  });
  if (blocked) {
    logger.warn("주문 차단(리스크)", { source: p.source, symbol, side: p.side, qty: p.qty, reason: blocked });
    return { ok: false, error: blocked, blockedBy: "risk" };
  }
  riskManager.recordOrder(amountUsd);

  const exch = p.exch ?? holding?.exch ?? quote?.exch ?? "NAS";
  const session = p.session ?? "regular";

  if (config.MOCK_DATA) {
    const order: Order = {
      orderId: `${p.source === "manual" ? "MOCK" : p.source.toUpperCase()}-${Date.now()}`,
      symbol,
      name: quote?.name ?? symbol,
      exch,
      side: p.side,
      orderType: p.orderType,
      session,
      qty: p.qty,
      filledQty: 0,
      price: refPrice,
      avgFillPrice: 0,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    state.orders.unshift(order);
    logger.info("모의 주문 접수", {
      source: p.source,
      orderId: order.orderId,
      symbol,
      side: p.side,
      qty: p.qty,
      reason: p.reason,
    });
    // 시장가는 잠시 후 모의 체결 — 포지션/현금이 실제로 움직여야 자동매매 검증이 된다
    if (p.orderType === "market") {
      setTimeout(() => state.fillMockOrder(order.orderId), 1000).unref();
    }
    return { ok: true, orderId: order.orderId, status: "accepted", refPrice };
  }

  try {
    const out = await kisClient.placeOrder({
      symbol,
      exch,
      side: p.side,
      orderType: p.orderType,
      qty: p.qty,
      price: refPrice,
      session,
    });
    logger.info("KIS 주문 접수", { source: p.source, odno: out.ODNO, symbol, side: p.side, qty: p.qty, reason: p.reason });
    return { ok: true, orderId: out.ODNO, status: "accepted", refPrice };
  } catch (e) {
    return { ok: false, error: (e as Error).message, blockedBy: "upstream" };
  }
}
