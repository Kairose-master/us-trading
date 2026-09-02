import { EventEmitter } from "node:events";
import type { Balance, Order, Position, Quote } from "../kis/types.js";
import { currentMarketSession } from "../core/marketSession.js";

/**
 * 인메모리 상태 저장소 + 목데이터 시뮬레이터.
 * MOCK_DATA=true면 KIS 없이 랜덤워크 틱을 생성해 프론트를 먼저 붙일 수 있다.
 * 실모드에서는 KIS 응답이 이 상태를 갱신한다.
 */
class AppState extends EventEmitter {
  balance: Balance = {
    cashUsd: 5000,
    totalEquityUsd: 7523.4,
    todayPnlUsd: 42.15,
    todayPnlPct: 0.56,
    totalPnlUsd: 223.4,
    totalPnlPct: 3.06,
    fxRate: 1380,
  };

  positions: Position[] = [
    mkPos("GME", "GameStop Corp.", "NYS", 40, 23.1, 22.07),
    mkPos("MARA", "MARA Holdings", "NAS", 25, 18.45, 19.2),
    mkPos("COIN", "Coinbase Global", "NAS", 3, 195.0, 201.5),
  ];

  orders: Order[] = [
    {
      orderId: "MOCK-0001",
      symbol: "GME",
      name: "GameStop Corp.",
      exch: "NYS",
      side: "buy",
      orderType: "limit",
      session: "regular",
      qty: 10,
      filledQty: 0,
      price: 21.5,
      avgFillPrice: 0,
      status: "open",
      createdAt: new Date().toISOString(),
    },
  ];

  quotes = new Map<string, Quote>();

  private mockTimer: NodeJS.Timeout | null = null;

  startMockTicks() {
    if (this.mockTimer) return;
    for (const p of this.positions) this.ensureQuote(p.symbol, p.name, p.exch, p.curPrice);
    this.mockTimer = setInterval(() => {
      for (const q of this.quotes.values()) {
        const drift = q.last * (Math.random() - 0.5) * 0.004; // ±0.2% 랜덤워크
        q.last = Math.max(0.01, +(q.last + drift).toFixed(2));
        q.change = +(q.last - q.prevClose).toFixed(2);
        q.changePct = +((q.change / q.prevClose) * 100).toFixed(2);
        q.bid = +(q.last - 0.01).toFixed(2);
        q.ask = +(q.last + 0.01).toFixed(2);
        q.volume += Math.floor(Math.random() * 500);
        q.session = currentMarketSession();
        this.emit("tick", q);
      }
      this.refreshPositionPrices();
    }, 1500);
    this.mockTimer.unref();
  }

  ensureQuote(symbol: string, name: string, exch: Quote["exch"], seed: number) {
    if (this.quotes.has(symbol)) return this.quotes.get(symbol)!;
    const q: Quote = {
      symbol,
      name,
      exch,
      last: seed,
      change: 0,
      changePct: 0,
      volume: 0,
      open: seed,
      high: seed,
      low: seed,
      prevClose: seed,
      bid: seed - 0.01,
      bidSize: 500,
      ask: seed + 0.01,
      askSize: 500,
      halted: false,
      session: currentMarketSession(),
    };
    this.quotes.set(symbol, q);
    return q;
  }

  /**
   * 모의 체결 — MOCK 모드에서 시장가 주문을 실제로 체결시켜
   * 포지션/현금이 움직이게 한다 (자동매매 검증의 전제).
   */
  fillMockOrder(orderId: string) {
    const order = this.orders.find((o) => o.orderId === orderId);
    if (!order || order.status !== "open") return;
    const q = this.quotes.get(order.symbol);
    const fillPrice = order.orderType === "market" ? (q?.last ?? order.price) : order.price;
    order.filledQty = order.qty;
    order.avgFillPrice = fillPrice;
    order.status = "filled";

    const pos = this.positions.find((p) => p.symbol === order.symbol);
    if (order.side === "buy") {
      this.balance.cashUsd = +(this.balance.cashUsd - fillPrice * order.qty).toFixed(2);
      if (pos) {
        pos.avgPrice = +((pos.avgPrice * pos.qty + fillPrice * order.qty) / (pos.qty + order.qty)).toFixed(4);
        pos.qty += order.qty;
      } else {
        this.positions.push(mkPos(order.symbol, order.name, order.exch, order.qty, fillPrice, fillPrice));
      }
    } else {
      const sellQty = order.qty === 0 ? (pos?.qty ?? 0) : order.qty;
      this.balance.cashUsd = +(this.balance.cashUsd + fillPrice * sellQty).toFixed(2);
      if (pos) {
        pos.qty -= sellQty;
        if (pos.qty <= 0) this.positions = this.positions.filter((p) => p.symbol !== order.symbol);
      }
    }
    this.refreshPositionPrices();
    this.emit("execution", {
      orderId,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: fillPrice,
      ts: new Date().toISOString(),
    });
  }

  refreshPositionPrices() {
    let equity = this.balance.cashUsd;
    for (const p of this.positions) {
      const q = this.quotes.get(p.symbol);
      if (q) p.curPrice = q.last;
      p.pnlUsd = +((p.curPrice - p.avgPrice) * p.qty).toFixed(2);
      p.pnlPct = +(((p.curPrice - p.avgPrice) / p.avgPrice) * 100).toFixed(2);
      equity += p.curPrice * p.qty;
    }
    const total = equity - this.balance.cashUsd;
    for (const p of this.positions) {
      p.weightPct = total > 0 ? +(((p.curPrice * p.qty) / total) * 100).toFixed(1) : 0;
    }
    this.balance.totalEquityUsd = +equity.toFixed(2);
    this.emit("position", this.positions);
  }
}

function mkPos(
  symbol: string,
  name: string,
  exch: Position["exch"],
  qty: number,
  avgPrice: number,
  curPrice: number
): Position {
  return {
    symbol,
    name,
    exch,
    qty,
    avgPrice,
    curPrice,
    pnlUsd: +((curPrice - avgPrice) * qty).toFixed(2),
    pnlPct: +(((curPrice - avgPrice) / avgPrice) * 100).toFixed(2),
    weightPct: 0,
    halted: false,
  };
}

export const state = new AppState();
