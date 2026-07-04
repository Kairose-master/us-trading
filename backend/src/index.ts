import express from "express";
import cors from "cors";
import http from "node:http";
import { config } from "./config.js";
import { router } from "./api/routes.js";
import { attachWsRelay } from "./api/wsRelay.js";
import { state } from "./api/state.js";
import { engine, type StrategyContext } from "./strategy/engine.js";
import { RsiReversal } from "./strategy/strategies/rsiReversal.js";
import { OuMeanReversion } from "./strategy/strategies/ouMeanReversion.js";
import { riskManager } from "./risk/riskManager.js";
import { kisWs } from "./kis/ws.js";
import { logger } from "./core/logger.js";

const app = express();
app.use(cors({ origin: ["http://localhost:3000"], credentials: false }));
app.use(express.json());

// 프론트-백엔드 간 간단 토큰 인증 (개인용)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.API_AUTH_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", router);

const server = http.createServer(app);
attachWsRelay(server);

// ===== 전략 엔진 배선 =====
const rsi = new RsiReversal({
  entryRule: "RSI(14) < 30 매수 / > 70 매도",
  stopLossPct: 5,
  takeProfitPct: 10,
  maxPositions: 3,
  maxAmountPerSymbolUsd: 500,
  allowedSession: "regular",
});
engine.register(rsi);

const ou = new OuMeanReversion({
  entryRule: "OU-HJB 자유경계: x ≤ x* 매수 / x ≥ x** 청산",
  stopLossPct: 5,
  takeProfitPct: 10,
  maxPositions: 3,
  maxAmountPerSymbolUsd: 500,
  allowedSession: "regular",
});
engine.register(ou);

// 전략 컨텍스트 팩토리: 전략별 로그 분리 + 주문도 리스크 관문 필수 통과
import type { Strategy } from "./strategy/engine.js";
const makeCtx = (s: Strategy): StrategyContext => ({
  requestOrder: async (p) => {
    const quote = state.quotes.get(p.symbol);
    if (!quote) return;
    const amountUsd = p.price * (p.qty || 1);
    const holding = state.positions.find((pos) => pos.symbol === p.symbol);
    const blocked = riskManager.check({
      amountUsd,
      side: p.side,
      resultingOpenPositions: state.positions.length + (p.side === "buy" && !holding ? 1 : 0),
      resultingSymbolWeightPct: 0, // 간이 계산 — routes.ts와 동일 로직으로 고도화 예정
    });
    if (blocked) {
      logger.warn(`전략 주문 차단: ${blocked}`, { strategy: s.id, symbol: p.symbol, reason: p.reason });
      return;
    }
    logger.info(`전략 주문 요청: ${p.side} ${p.symbol} x${p.qty} @ $${p.price}`, {
      strategy: s.id,
      reason: p.reason,
    });
    // MOCK 모드: 주문 기록만. 실모드 전환 시 kisClient.placeOrder 연결.
  },
  log: (level, message, context) => {
    s.logs.push({ ts: new Date().toISOString(), level, message, context });
    if (s.logs.length > 500) s.logs.shift();
  },
});

state.on("tick", (q) => engine.dispatchTick(q, makeCtx));

// ===== 기동 =====
if (config.MOCK_DATA) {
  state.startMockTicks();
  logger.info("MOCK_DATA 모드 — KIS 연결 없이 목데이터로 동작");
} else {
  kisWs.connect().catch((e) => logger.error("KIS WS 초기 연결 실패", { error: e.message }));
}

server.listen(config.PORT, () => {
  logger.info(`백엔드 기동: http://localhost:${config.PORT} (mode=${config.KIS_MODE}, mock=${config.MOCK_DATA})`);
});
