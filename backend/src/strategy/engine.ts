import { EventEmitter } from "node:events";
import { logger, type LogEntry } from "../core/logger.js";
import { riskManager } from "../risk/riskManager.js";
import type { Quote, Session } from "../kis/types.js";

export interface StrategyConfig {
  entryRule: string;
  stopLossPct: number;
  takeProfitPct: number;
  maxPositions: number;
  maxAmountPerSymbolUsd: number;
  allowedSession: Session;
}

export interface StrategyContext {
  /** 주문 요청 — 반드시 riskManager를 통과한 뒤 실제 주문 실행부로 전달됨 */
  requestOrder: (p: {
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    price: number;
    reason: string;
  }) => Promise<void>;
  log: (level: LogEntry["level"], message: string, context?: Record<string, unknown>) => void;
}

export abstract class Strategy {
  abstract id: string;
  abstract name: string;
  config: StrategyConfig;
  status: "running" | "stopped" | "error" = "stopped";
  todayPnlUsd = 0;
  positionCount = 0;
  logs: LogEntry[] = [];

  constructor(config: StrategyConfig) {
    this.config = config;
  }

  /** 매 틱마다 호출 — 전략 로직의 진입점 */
  abstract onTick(quote: Quote, ctx: StrategyContext): Promise<void>;
}

class StrategyEngine extends EventEmitter {
  strategies = new Map<string, Strategy>();

  register(s: Strategy) {
    this.strategies.set(s.id, s);
  }

  start(id: string) {
    const s = this.strategies.get(id);
    if (!s) throw new Error("strategy not found");
    if (riskManager.killSwitchActive) throw new Error("킬스위치 활성화 상태 — 시작 불가");
    s.status = "running";
    logger.info(`전략 시작: ${s.name}`);
  }

  stop(id: string) {
    const s = this.strategies.get(id);
    if (!s) throw new Error("strategy not found");
    s.status = "stopped";
    logger.info(`전략 정지: ${s.name}`);
  }

  stopAll(): string[] {
    const stopped: string[] = [];
    for (const s of this.strategies.values()) {
      if (s.status === "running") {
        s.status = "stopped";
        stopped.push(s.id);
      }
    }
    return stopped;
  }

  async dispatchTick(quote: Quote, makeCtx: (s: Strategy) => StrategyContext) {
    for (const s of this.strategies.values()) {
      if (s.status !== "running") continue;
      try {
        await s.onTick(quote, makeCtx(s));
      } catch (e) {
        s.status = "error";
        logger.error(`전략 오류로 정지: ${s.name}`, { error: (e as Error).message });
      }
    }
  }
}

export const engine = new StrategyEngine();
