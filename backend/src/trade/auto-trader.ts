import { pipeline } from "../pipeline/engine.js";
import { executeOrder } from "./execute.js";
import { riskManager } from "../risk/riskManager.js";
import { state } from "../api/state.js";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import type { ExecutionSignal } from "../pipeline/types.js";

/**
 * 자동매매 실행기 — 파이프라인 실행 신호를 실제 주문으로 바꾸는 마지막 한 칸.
 *
 * 안전 설계 (전부 겹겹이, 어느 하나로도 멈춘다):
 *  1. 기본 OFF — env AUTO_TRADE=true 또는 런타임 토글로만 켜진다.
 *  2. 실모드(KIS real + MOCK_DATA=false)는 AUTO_TRADE_ALLOW_REAL=true 없이는
 *     켜지지 않는다 (Handsel lineage-mandate와 같은 패턴).
 *  3. 킬스위치 활성화 시 즉시 무시.
 *  4. 주문은 executeOrder 공용 경로 → riskManager.check() 필수 통과.
 *  5. 심볼당 쿨다운 + 1회 주문 금액 상한(리스크 한도의 절반).
 */

export interface AutoTradeRecord {
  ts: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  refPrice: number;
  orderId: string | null;
  outcome: "accepted" | "blocked" | "error";
  detail: string;
}

const COOLDOWN_MS = 5 * 60_000;
const HISTORY_MAX = 100;

class AutoTrader {
  enabled = false;
  private cooldown = new Map<string, number>();
  history: AutoTradeRecord[] = [];
  startedAt: string | null = null;

  /** 켜기 — 실모드 가드 포함. 실패 사유를 반환하면 켜지지 않은 것. */
  enable(): string | null {
    const realMoneyPath = !config.MOCK_DATA && config.KIS_MODE === "real";
    if (realMoneyPath && !config.AUTO_TRADE_ALLOW_REAL) {
      return "실모드(real+실데이터)에서는 AUTO_TRADE_ALLOW_REAL=true 없이 자동매매를 켤 수 없습니다";
    }
    if (riskManager.killSwitchActive) {
      return "킬스위치 활성화 상태 — 해제 후 다시 시도하세요";
    }
    this.enabled = true;
    this.startedAt = new Date().toISOString();
    logger.info("자동매매 ON", { mock: config.MOCK_DATA, kisMode: config.KIS_MODE });
    return null;
  }

  disable() {
    this.enabled = false;
    logger.info("자동매매 OFF");
  }

  status() {
    return {
      enabled: this.enabled,
      startedAt: this.startedAt,
      killSwitchActive: riskManager.killSwitchActive,
      mock: config.MOCK_DATA,
      kisMode: config.KIS_MODE,
      executedToday: this.history.filter((h) => h.outcome === "accepted").length,
      recent: this.history.slice(0, 20),
    };
  }

  /** 파이프라인 실행 신호 1건 처리 */
  async onSignal(sig: ExecutionSignal) {
    if (!this.enabled) return;
    if (riskManager.killSwitchActive) return;
    if (sig.blocked) return; // 파이프라인 단계에서 이미 리스크 차단된 신호

    const now = Date.now();
    const last = this.cooldown.get(sig.symbol) ?? 0;
    if (now - last < COOLDOWN_MS) return;
    this.cooldown.set(sig.symbol, now);

    const quote = state.quotes.get(sig.symbol);
    if (!quote || quote.last <= 0) return;

    // 사이징: 신호 강도(비중 괴리 %p) × 자산, 단 1회 한도의 절반을 상한으로
    const budget = Math.min(
      (sig.strengthPct / 100) * state.balance.totalEquityUsd,
      riskManager.limits.maxOrderAmountUsd * 0.5,
    );
    let qty: number;
    if (sig.side === "sell") {
      const pos = state.positions.find((p) => p.symbol === sig.symbol);
      if (!pos) return; // 없는 것을 팔지 않는다 (공매도 없음)
      qty = Math.min(pos.qty, Math.max(1, Math.floor(budget / quote.last)));
    } else {
      qty = Math.floor(budget / quote.last);
      if (qty < 1) return; // 1주도 못 사는 신호는 버린다
    }

    const result = await executeOrder({
      symbol: sig.symbol,
      side: sig.side,
      orderType: "market",
      qty,
      session: "regular",
      source: "auto-trade",
      reason: sig.reason,
    });

    const record: AutoTradeRecord = {
      ts: new Date().toISOString(),
      symbol: sig.symbol,
      side: sig.side,
      qty,
      refPrice: quote.last,
      orderId: result.ok ? result.orderId : null,
      outcome: result.ok ? "accepted" : result.blockedBy === "risk" ? "blocked" : "error",
      detail: result.ok ? sig.reason : result.error,
    };
    this.history.unshift(record);
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;

    pipeline.log(
      "auto-trade",
      result.ok
        ? `${sig.symbol} ${sig.side.toUpperCase()} ${qty}주 주문 접수 (${record.orderId}) — ${sig.reason}`
        : `${sig.symbol} ${sig.side.toUpperCase()} 주문 실패 — ${result.error}`,
    );
  }

  /** 파이프라인에 배선 — 신호 큐를 폴링하는 대신 엔진 이벤트에 직접 붙는다 */
  attach() {
    pipeline.on("signal", (sig: ExecutionSignal) => void this.onSignal(sig));
    if (config.AUTO_TRADE) {
      const err = this.enable();
      if (err) logger.warn("AUTO_TRADE=true 였지만 켜지 못함", { reason: err });
    }
  }
}

export const autoTrader = new AutoTrader();
