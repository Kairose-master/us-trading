import express from "express";
import cors from "cors";
import http from "node:http";
import { config } from "./config.js";
import { router } from "./api/routes.js";
import { authRouter } from "./auth/routes.js";
import { attachWsRelay } from "./api/wsRelay.js";
import { state } from "./api/state.js";
import { riskManager } from "./risk/riskManager.js";
import { kisWs } from "./kis/ws.js";
import { logger } from "./core/logger.js";
import { pipeline } from "./pipeline/engine.js";
import { newsIngestor } from "./sentiment/news.js";
import { handleMcpRequest } from "./mcp/server.js";
import { autoTrader } from "./trade/auto-trader.js";
import { cryptoDesk } from "./crypto/desk.js";
import { scannerServer } from "./crypto/scanner-server.js";
import { startYahooTicks } from "./data/yahoo.js";
import { officeLoop } from "./office/loop.js";

const app = express();
app.use(cors({ origin: config.corsOrigins, credentials: false }));
app.use(express.json());

// 프론트-백엔드 간 간단 토큰 인증 (개인용)
// /mcp는 자체 토큰(MCP_AUTH_TOKEN)으로 인증한다 — Handsel이 저장하는 정적
// Authorization 헤더가 그 토큰이므로 이 미들웨어에서는 통과시킨다.
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/mcp") return next();
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.API_AUTH_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/mcp", (req, res) => void handleMcpRequest(req, res));
app.use("/api", authRouter);
app.use("/api", router);

const server = http.createServer(app);
attachWsRelay(server);


// ===== 데이터/ML 파이프라인 배선 =====
// 정형(시세 틱) + 비정형(뉴스) 소스를 하나의 DAG로 처리한다.
const trackedSymbols = [
  ...new Set([...state.positions.map((p) => p.symbol), "NVDA", "TSLA", "AAPL", "MSFT", "GOOGL"]),
];
pipeline.start(trackedSymbols);
state.on("tick", (q) => pipeline.onTick(q));
newsIngestor.setSymbols(trackedSymbols);
newsIngestor.on("news", (items) => pipeline.onNews(items));
newsIngestor.start();

// 자동매매 실행기 — 파이프라인 신호에 배선 (기본 OFF, env/REST/MCP로 토글)
autoTrader.attach();

// 크립토 데스크 (Upbit) — 공개 API 실데이터, MOCK_DATA와 무관하게 기동
cryptoDesk.start();
scannerServer.startAutoLoop();
officeLoop.startAutoLoop();

// ===== 기동 =====
if (config.MOCK_DATA) {
  // KIS 키 없음 → 시세는 Yahoo Finance 실데이터(지연)로. 랜덤워크 가짜 틱은
  // 쓰지 않는다 — 파이프라인이 먹는 가격은 항상 실제 가격이어야 한다.
  // 계좌/포지션/주문만 모의 상태로 남는다 (실계좌 아님, 화면에 mock 표기).
  startYahooTicks(trackedSymbols);
  logger.info("MOCK_DATA 모드 — KIS 계좌는 모의, 시세는 Yahoo Finance 실데이터");
} else {
  kisWs.connect().catch((e) => logger.error("KIS WS 초기 연결 실패", { error: e.message }));
}

server.listen(config.PORT, () => {
  logger.info(`백엔드 기동: http://localhost:${config.PORT} (mode=${config.KIS_MODE}, mock=${config.MOCK_DATA})`);
});
