import { logger } from "../core/logger.js";
import type { RiskLimits, RiskUsage } from "../kis/types.js";

/**
 * 리스크 매니저 — 모든 주문은 반드시 check()를 통과해야 한다.
 * 전략 엔진이든 수동 주문이든 예외 없음. (단일 관문 원칙)
 */
class RiskManager {
  limits: RiskLimits = {
    maxOrderAmountUsd: 1000,
    maxDailyLossUsd: 300,
    maxSymbolWeightPct: 25,
    maxOpenPositions: 5,
  };

  usage: RiskUsage = {
    orderAmountTodayUsd: 0,
    dailyLossTodayUsd: 0,
    openPositions: 0,
  };

  killSwitchActive = false;

  /** 주문 사전 점검. 통과 못 하면 사유 문자열 반환(주문 차단), 통과 시 null */
  check(p: {
    amountUsd: number;
    side: "buy" | "sell";
    resultingOpenPositions: number;
    resultingSymbolWeightPct: number;
  }): string | null {
    if (this.killSwitchActive) return "킬스위치 활성화 상태 — 모든 주문 차단됨";
    if (p.amountUsd > this.limits.maxOrderAmountUsd)
      return `1회 최대 주문금액($${this.limits.maxOrderAmountUsd}) 초과`;
    if (this.usage.dailyLossTodayUsd >= this.limits.maxDailyLossUsd)
      return `일일 최대 손실($${this.limits.maxDailyLossUsd}) 도달 — 신규 주문 차단`;
    if (p.side === "buy" && p.resultingOpenPositions > this.limits.maxOpenPositions)
      return `최대 동시 포지션 수(${this.limits.maxOpenPositions}) 초과`;
    if (p.side === "buy" && p.resultingSymbolWeightPct > this.limits.maxSymbolWeightPct)
      return `종목당 최대 비중(${this.limits.maxSymbolWeightPct}%) 초과`;
    return null;
  }

  recordOrder(amountUsd: number) {
    this.usage.orderAmountTodayUsd += amountUsd;
  }

  recordRealizedPnl(pnlUsd: number) {
    if (pnlUsd < 0) this.usage.dailyLossTodayUsd += Math.abs(pnlUsd);
    if (this.usage.dailyLossTodayUsd >= this.limits.maxDailyLossUsd) {
      logger.warn("일일 손실 한도 도달 — 킬스위치 자동 활성화");
      this.activateKillSwitch();
    }
  }

  activateKillSwitch(): void {
    this.killSwitchActive = true;
    logger.error("⛔ KILL SWITCH ACTIVATED — 전체 자동매매 정지");
  }

  deactivateKillSwitch(): void {
    this.killSwitchActive = false;
    logger.warn("킬스위치 해제됨 — 수동 재개");
  }

  /** 자정(KST) 리셋용 */
  resetDaily() {
    this.usage.orderAmountTodayUsd = 0;
    this.usage.dailyLossTodayUsd = 0;
  }
}

export const riskManager = new RiskManager();
