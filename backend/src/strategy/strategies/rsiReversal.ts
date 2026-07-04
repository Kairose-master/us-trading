import { Strategy, type StrategyContext } from "../engine.js";
import type { Quote } from "../../kis/types.js";

/**
 * RSI 역추세 예시 전략.
 * - 틱 가격을 모아 14기간 RSI 계산
 * - RSI < 30 → 매수 시그널 / RSI > 70 → 매도 시그널
 * 실전용이라기보단 엔진 배선 확인용 골격. 파라미터·신호는 백테스트로 검증할 것.
 */
export class RsiReversal extends Strategy {
  id = "rsi-reversal";
  name = "RSI 역추세";

  private prices = new Map<string, number[]>();
  private cooldown = new Map<string, number>(); // 심볼별 마지막 주문 시각

  async onTick(q: Quote, ctx: StrategyContext) {
    const arr = this.prices.get(q.symbol) ?? [];
    arr.push(q.last);
    if (arr.length > 200) arr.shift();
    this.prices.set(q.symbol, arr);
    if (arr.length < 15) return;

    const rsi = this.rsi14(arr);
    const last = this.cooldown.get(q.symbol) ?? 0;
    if (Date.now() - last < 60_000) return; // 심볼당 1분 쿨다운

    if (rsi < 30) {
      const qty = Math.max(1, Math.floor(this.config.maxAmountPerSymbolUsd / q.last));
      ctx.log("INFO", `RSI=${rsi.toFixed(1)} < 30 → 매수 시그널`, { symbol: q.symbol, price: q.last });
      this.cooldown.set(q.symbol, Date.now());
      await ctx.requestOrder({
        symbol: q.symbol,
        side: "buy",
        qty,
        price: q.ask,
        reason: `RSI ${rsi.toFixed(1)} oversold`,
      });
    } else if (rsi > 70) {
      ctx.log("INFO", `RSI=${rsi.toFixed(1)} > 70 → 매도 시그널`, { symbol: q.symbol, price: q.last });
      this.cooldown.set(q.symbol, Date.now());
      await ctx.requestOrder({
        symbol: q.symbol,
        side: "sell",
        qty: 0, // 0 = 보유 전량 (실행부에서 해석)
        price: q.bid,
        reason: `RSI ${rsi.toFixed(1)} overbought`,
      });
    }
  }

  private rsi14(prices: number[]): number {
    const period = 14;
    const slice = prices.slice(-(period + 1));
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < slice.length; i++) {
      const d = slice[i] - slice[i - 1];
      if (d > 0) gains += d;
      else losses -= d;
    }
    if (losses === 0) return 100;
    const rs = gains / period / (losses / period);
    return 100 - 100 / (1 + rs);
  }
}
