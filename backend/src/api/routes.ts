import { Router } from "express";
import { z } from "zod";
import { state, US_PAPER_START_USD } from "./state.js";
import { usdKrw } from "../data/fx.js";
import { riskManager } from "../risk/riskManager.js";
import { kisClient } from "../kis/client.js";
import { kisWs } from "../kis/ws.js";
import { tokenManager } from "../kis/auth.js";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { currentMarketSession, nextRegularOpenEt } from "../core/marketSession.js";
import { pipeline } from "../pipeline/engine.js";
import { executeOrder } from "../trade/execute.js";
import { autoTrader } from "../trade/auto-trader.js";
import { cryptoDesk } from "../crypto/desk.js";
import { scannerServer } from "../crypto/scanner-server.js";
import { officeLoop } from "../office/loop.js";
import { OFFICE_ROSTER, OFFICE_TEMPLATE_ID, rosterEdges } from "../office/roster.js";
import { supervisor, type Market as SupMarket } from "../core/supervisor.js";
import { evolution } from "../evolution/population.js";
import { candleStoreStatus, getDayCandles } from "../crypto/candle-store.js";
import { controlPlane, type EngineId } from "../control/plane.js";
import { upbitRateStatus } from "../crypto/upbit.js";
import { requireSession } from "../auth/routes.js";
import { upbit } from "../crypto/upbit.js";
import { runBacktest, SIGNALS } from "../crypto/backtest.js";
import { walkForwardValidate } from "../ml/validate.js";
import { DEFAULT_PARAMS } from "../ml/train.js";
import { tuneHyperparams } from "../ml/tune.js";
import { buildQuantReport } from "../quant/report.js";
import type { Exchange, Order } from "../kis/types.js";

export const router = Router();

// ===== 계좌 =====

router.get("/account/balance", async (_req, res) => {
  const fx = await usdKrw();
  state.balance.fxRate = fx.rate;
  res.json({ ...state.balance, connected: !config.MOCK_DATA, mode: config.MOCK_DATA ? "paper" : config.KIS_MODE, paperStartUsd: US_PAPER_START_USD });
});

router.get("/account/positions", (_req, res) => {
  res.json(state.positions);
});

/**
 * 통합 보유 — 크립토 페이퍼 장부(Upbit 실시세) + 미국 장부(KIS 실계좌 또는 페이퍼).
 * 화면의 모든 숫자는 여기서 온 실기록이다. 미국 쪽은 KIS 키가 없으면 connected=false,
 * 보유는 비어 있고 페이퍼 현금만 있다. 환율은 Yahoo KRW=X (0이면 미수신).
 */
router.get("/account/holdings", async (_req, res) => {
  const fx = await usdKrw();
  const c = cryptoDesk.status();
  const cryptoPositions = c.positions.map((p) => {
    const value = p.qty * p.curKrw;
    const cost = p.qty * p.avgKrw;
    return { ...p, valueKrw: Math.round(value), pnlKrw: Math.round(value - cost), pnlPct: cost > 0 ? +(((value - cost) / cost) * 100).toFixed(2) : 0, weightPct: c.equityKrw > 0 ? +((value / c.equityKrw) * 100).toFixed(1) : 0 };
  });
  const usEquityUsd = state.balance.totalEquityUsd;
  res.json({
    ts: new Date().toISOString(),
    fx,
    crypto: {
      mode: c.mode,
      hasKeys: c.hasKeys,
      since: c.paperSince,
      startKrw: c.paperStartKrw,
      cashKrw: c.cashKrw,
      equityKrw: c.equityKrw,
      pnlKrw: c.equityKrw - c.paperStartKrw,
      pnlPct: +(((c.equityKrw - c.paperStartKrw) / c.paperStartKrw) * 100).toFixed(2),
      positions: cryptoPositions,
    },
    us: {
      connected: !config.MOCK_DATA,
      mode: config.MOCK_DATA ? "paper" : config.KIS_MODE,
      startUsd: US_PAPER_START_USD,
      cashUsd: state.balance.cashUsd,
      equityUsd: usEquityUsd,
      pnlUsd: state.balance.totalPnlUsd,
      pnlPct: state.balance.totalPnlPct,
      positions: state.positions,
    },
    totalKrw: fx.rate > 0 ? Math.round(c.equityKrw + usEquityUsd * fx.rate) : null,
  });
});

// ===== 시세 =====

router.get("/quotes/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const q = state.quotes.get(symbol);
  if (q) return res.json(q);
  if (config.MOCK_DATA) {
    // Yahoo가 아직 이 종목을 채우지 않았다 — $100 자리표시 시세를 만들어 주던 것을 끝낸다.
    // 화면은 "시세 미수신"을 그대로 보여주고 다음 폴링에서 다시 받는다.
    return res.status(503).json({ error: `${symbol} 시세 미수신 (Yahoo 대기)`, code: "QUOTE_PENDING" });
  }
  try {
    const exch = (req.query.exch as Exchange) ?? "NAS";
    const raw = await kisClient.price(symbol, exch);
    // ⚠️ 필드 매핑은 KIS 문서 대조 필요
    const quote = state.ensureQuote(symbol, symbol, exch, parseFloat(raw.last ?? "0"));
    quote.prevClose = parseFloat(raw.base ?? "0");
    res.json(quote);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.get("/quotes/:symbol/chart", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const count = Number(req.query.count ?? 120);
  if (config.MOCK_DATA) {
    // 랜덤워크 캔들 생성
    const q = state.quotes.get(symbol);
    let c = q?.last ?? 100;
    const candles = Array.from({ length: count }, (_, i) => {
      const o = c;
      c = Math.max(0.01, c * (1 + (Math.random() - 0.5) * 0.01));
      const h = Math.max(o, c) * 1.002;
      const l = Math.min(o, c) * 0.998;
      return {
        t: new Date(Date.now() - (count - i) * 60_000).toISOString(),
        o: +o.toFixed(2),
        h: +h.toFixed(2),
        l: +l.toFixed(2),
        c: +c.toFixed(2),
        v: Math.floor(Math.random() * 10_000),
      };
    });
    return res.json(candles);
  }
  try {
    const exch = (req.query.exch as Exchange) ?? "NAS";
    const raw = await kisClient.dailyChart(symbol, exch, count);
    res.json(
      raw.map((r: Record<string, string>) => ({
        t: r.xymd,
        o: parseFloat(r.open),
        h: parseFloat(r.high),
        l: parseFloat(r.low),
        c: parseFloat(r.clos),
        v: parseInt(r.tvol, 10),
      }))
    );
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// ===== 주문 =====

const OrderBody = z.object({
  symbol: z.string().min(1).max(6),
  exch: z.enum(["NAS", "NYS", "AMS"]),
  side: z.enum(["buy", "sell"]),
  orderType: z.enum(["limit", "market"]),
  qty: z.number().int().positive(),
  price: z.number().positive().optional(),
  session: z.enum(["regular", "extended"]).default("regular"),
});

router.post("/orders", async (req, res) => {
  const parsed = OrderBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const p = parsed.data;

  // 수동/자동/MCP 모두 같은 실행 경로 — 리스크 관문은 executeOrder 안에서 단 한 번
  const result = await executeOrder({ ...p, source: "manual" });
  if (!result.ok) {
    const status = result.blockedBy === "risk" ? 409 : result.blockedBy === "input" ? 400 : 502;
    return res.status(status).json({ error: result.error });
  }
  res.json({ orderId: result.orderId, status: result.status });
});

router.get("/orders", (req, res) => {
  const status = (req.query.status as string) ?? "all";
  let list = state.orders;
  if (status === "open") list = list.filter((o) => o.status === "open" || o.status === "partial");
  if (status === "filled") list = list.filter((o) => o.status === "filled");
  res.json(list);
});

router.delete("/orders/:orderId", async (req, res) => {
  const order = state.orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ error: "주문 없음" });
  if (config.MOCK_DATA) {
    order.status = "cancelled";
    return res.json({ ok: true });
  }
  try {
    await kisClient.cancelOrder({
      symbol: order.symbol,
      exch: order.exch,
      orderId: order.orderId,
      qty: order.qty - order.filledQty,
    });
    order.status = "cancelled";
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// ===== 리스크 =====

router.get("/risk/limits", (_req, res) => {
  res.json({ ...riskManager.limits, usage: riskManager.usage });
});

router.patch("/risk/limits", (req, res) => {
  riskManager.limits = { ...riskManager.limits, ...req.body };
  logger.info("리스크 한도 변경", req.body);
  res.json({ ok: true });
});

router.post("/risk/killswitch", (_req, res) => {
  riskManager.activateKillSwitch();
  res.json({ ok: true });
});

// ===== 파이프라인 =====

router.get("/pipeline", (_req, res) => {
  res.json(pipeline.snapshot());
});

router.get("/pipeline/nodes/:id", (req, res) => {
  const detail = pipeline.nodeDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "노드 없음" });
  res.json(detail);
});

router.get("/pipeline/logs", (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  res.json(pipeline.logs.slice(0, limit));
});

router.get("/pipeline/targets", (_req, res) => {
  res.json(pipeline.portfolioTargets);
});

router.get("/pipeline/signals", (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json(pipeline.signals.slice(0, limit));
});

// ===== 감성 =====

router.get("/sentiment", (_req, res) => {
  const t = pipeline.tracker;
  const index = t.marketIndex();
  res.json({
    index,
    label: index > 0.15 ? "BULLISH" : index < -0.15 ? "BEARISH" : "NEUTRAL",
    totalMentions: t.totalMentions(),
    symbols: t.bySymbol(),
    sources: t.sources(),
  });
});

router.get("/sentiment/feed", (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json(pipeline.tracker.feed.slice(0, limit));
});

// ===== 자동매매 =====

router.get("/autotrade", (_req, res) => {
  res.json(autoTrader.status());
});

router.post("/autotrade", (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled: boolean 필요" });
  if (enabled) {
    const err = autoTrader.enable();
    if (err) return res.status(409).json({ error: err });
  } else {
    autoTrader.disable();
  }
  res.json(autoTrader.status());
});

// ===== 크립토 (Upbit — 항상 실데이터) =====

router.get("/crypto/status", (_req, res) => {
  res.json(cryptoDesk.status());
});

router.get("/crypto/quotes", (_req, res) => {
  res.json(cryptoDesk.quotes());
});

router.get("/crypto/pipeline", (_req, res) => {
  res.json(cryptoDesk.pipeline.snapshot());
});

router.get("/crypto/pipeline/nodes/:id", (req, res) => {
  const detail = cryptoDesk.pipeline.nodeDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "노드 없음" });
  res.json(detail);
});

router.get("/crypto/pipeline/logs", (req, res) => {
  res.json(cryptoDesk.pipeline.logs.slice(0, Number(req.query.limit ?? 100)));
});

router.get("/crypto/sentiment", (_req, res) => {
  const t = cryptoDesk.pipeline.tracker;
  const index = t.marketIndex();
  res.json({
    index,
    label: index > 0.15 ? "BULLISH" : index < -0.15 ? "BEARISH" : "NEUTRAL",
    totalMentions: t.totalMentions(),
    symbols: t.bySymbol(),
    sources: t.sources(),
  });
});

router.get("/crypto/sentiment/feed", (req, res) => {
  res.json(cryptoDesk.pipeline.tracker.feed.slice(0, Number(req.query.limit ?? 50)));
});

router.get("/crypto/signals", (_req, res) => {
  res.json(SIGNALS.map(({ id, name, description, code }) => ({ id, name, description, code })));
});

router.get("/crypto/backtest", async (req, res) => {
  const market = String(req.query.market ?? "KRW-BTC");
  const signalId = String(req.query.signal ?? "momentum-20");
  const days = Math.min(1000, Math.max(90, Number(req.query.days ?? 365)));
  const signal = SIGNALS.find((s) => s.id === signalId);
  if (!signal) return res.status(404).json({ error: `시그널 없음: ${signalId}` });
  try {
    const candles = await upbit.dayCandles(market, days);
    if (candles.length < 90) return res.status(422).json({ error: `캔들 부족 (${candles.length}개)` });
    const bt = runBacktest(
      candles.map((c) => ({ t: c.candle_date_time_utc.slice(0, 10), o: c.opening_price, h: c.high_price, l: c.low_price, c: c.trade_price, v: c.candle_acc_trade_volume })),
      signal,
      market,
    );
    res.json(bt);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// ===== ML (Model Lab) =====

router.get("/ml/train", async (req, res) => {
  const market = String(req.query.market ?? "KRW-BTC");
  const days = Math.min(1000, Math.max(200, Number(req.query.days ?? 500)));
  const params = {
    learningRate: Math.min(1, Math.max(0.001, Number(req.query.lr ?? DEFAULT_PARAMS.learningRate))),
    epochs: Math.min(300, Math.max(5, Math.round(Number(req.query.epochs ?? DEFAULT_PARAMS.epochs)))),
    l2: Math.min(0.1, Math.max(0, Number(req.query.l2 ?? DEFAULT_PARAMS.l2))),
    batchSize: Math.min(128, Math.max(4, Math.round(Number(req.query.batch ?? DEFAULT_PARAMS.batchSize)))),
    seed: Math.round(Number(req.query.seed ?? DEFAULT_PARAMS.seed)),
  };
  // quantile: 학습셋 예측확률 분위수 — 0.6 = 상위 40% 확신일에만 롱
  const quantile = Math.min(0.9, Math.max(0.5, Number(req.query.quantile ?? 0.6)));
  try {
    const candles = (await upbit.dayCandles(market, days)).map((c) => ({
      t: c.candle_date_time_utc.slice(0, 10),
      o: c.opening_price,
      h: c.high_price,
      l: c.low_price,
      c: c.trade_price,
      v: c.candle_acc_trade_volume,
    }));
    const report = walkForwardValidate(candles, market, params, quantile);
    res.json(report);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.get("/ml/tune", async (req, res) => {
  const market = String(req.query.market ?? "KRW-BTC");
  const days = Math.min(1000, Math.max(300, Number(req.query.days ?? 500)));
  const opts = {
    randomTrials: Math.min(40, Math.max(5, Math.round(Number(req.query.trials ?? 20)))),
    refineSteps: Math.min(20, Math.max(0, Math.round(Number(req.query.refine ?? 10)))),
    seed: Math.round(Number(req.query.seed ?? 7)),
  };
  try {
    const candles = (await upbit.dayCandles(market, days)).map((c) => ({
      t: c.candle_date_time_utc.slice(0, 10),
      o: c.opening_price,
      h: c.high_price,
      l: c.low_price,
      c: c.trade_price,
      v: c.candle_acc_trade_volume,
    }));
    res.json(tuneHyperparams(candles, market, opts));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// ===== 퀀트 코어 (레짐/변동성/배분/리스크/통계) =====

router.get("/quant/report", async (req, res) => {
  const market = String(req.query.market ?? "KRW-BTC");
  const days = Math.min(1000, Math.max(200, Number(req.query.days ?? 500)));
  try {
    const candles = (await upbit.dayCandles(market, days)).map((c) => ({
      t: c.candle_date_time_utc.slice(0, 10),
      o: c.opening_price,
      h: c.high_price,
      l: c.low_price,
      c: c.trade_price,
      v: c.candle_acc_trade_volume,
    }));
    res.json(buildQuantReport(candles, market));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// 페이퍼 에쿼티 커브 — 재시작을 견디는 라이브 기록 (data/crypto-paper-equity.jsonl)
router.get("/crypto/paper/equity", (req, res) => {
  res.json(cryptoDesk.paperEquity(Number(req.query.limit ?? 2000)));
});

// ===== 알트코인 스캐너 (KRW 전 마켓 → 위험조정 랭킹 → 상위K 로테이션, 페이퍼 전용) =====

router.get("/crypto/scanner", async (req, res) => {
  try {
    res.json({ ...(await scannerServer.scan(req.query.force === "true")), lastRotation: scannerServer.lastRotation, autoRotate: config.CRYPTO_SCANNER });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.get("/crypto/scanner/backtest", async (req, res) => {
  try {
    const bt = await scannerServer.backtest(req.query.force === "true");
    if (!bt) return res.status(422).json({ error: "데이터 부족 — 백테스트 불가" });
    res.json(bt);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.post("/crypto/scanner/rotate", async (_req, res) => {
  try {
    const r = await scannerServer.rotate();
    if (r.error) return res.status(409).json(r);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.post("/crypto/autotrade", (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled: boolean 필요" });
  const err = cryptoDesk.setTrade(enabled);
  if (err) return res.status(409).json({ error: err });
  res.json(cryptoDesk.status());
});

// ===== 오피스 결정 루프 (대화 → 결정 → 페이퍼 매매) =====

router.get("/office/roster", (_req, res) => {
  res.json({ templateId: OFFICE_TEMPLATE_ID, roles: OFFICE_ROSTER, edges: rosterEdges(), workerUrl: config.OFFICE_WORKER_URL });
});

router.get("/office/status", (_req, res) => {
  res.json(officeLoop.status());
});

router.get("/office/runs", (_req, res) => {
  res.json(officeLoop.list());
});

router.get("/office/runs/:id", (req, res) => {
  const r = officeLoop.get(req.params.id);
  if (!r) return res.status(404).json({ error: "run 없음" });
  res.json(r);
});

// 수동 1회 실행 — Handsel escrow(테스트넷 기본)와 페이퍼 회전이 실제로 일어난다
router.post("/office/run", requireSession, async (req, res) => {
  try {
    const budget = req.body?.budgetUsd !== undefined ? Number(req.body.budgetUsd) : undefined;
    const mode = req.body?.mode === "handsel" || req.body?.mode === "local" ? (req.body.mode as "handsel" | "local") : undefined;
    res.json(await officeLoop.runOnce({ budgetUsd: budget, mode }));
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// ===== 시스템 =====

router.get("/system/status", (_req, res) => {
  res.json({
    ws: config.MOCK_DATA ? "connected" : kisWs.status,
    apiUsagePct: kisClient.limiter.usagePct(),
    kisTokenExpiresAt: tokenManager.expiresAtIso,
    killSwitchActive: riskManager.killSwitchActive,
    marketSession: currentMarketSession(),
    nextSessionStartEt: nextRegularOpenEt(),
  });
});

// ===== 수집 감독자 (self-healing) — 읽기 공개, 조작은 로그인 세션 =====

router.get("/ops/supervisor", (req, res) => {
  res.json(supervisor.snapshot((req.query.market as SupMarket) || undefined));
});
router.get("/ops/supervisor/logs", (req, res) => {
  res.json(supervisor.logs(Number(req.query.limit ?? 100), (req.query.market as SupMarket) || undefined));
});
router.post("/ops/supervisor/pause", requireSession, (_req, res) => { supervisor.pause(); res.json({ ok: true }); });
router.post("/ops/supervisor/resume", requireSession, (_req, res) => { supervisor.resume(); res.json({ ok: true }); });
router.post("/ops/supervisor/heal", requireSession, (_req, res) => { supervisor.healAll(); res.json({ ok: true }); });
router.post("/ops/supervisor/auto-recovery", requireSession, (req, res) => { supervisor.setAutoRecovery(Boolean(req.body?.on)); res.json({ ok: true }); });
router.post("/ops/supervisor/:id/break", requireSession, (req, res) => {
  try {
    supervisor.breakSource(String(req.params.id), Number(req.body?.seconds ?? 30));
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

// ===== 진화 — 전략 개체군 (페이퍼) =====

router.get("/evolution", (_req, res) => {
  res.json({ ...evolution.status(), squad: evolution.squad(), history: evolution.history().slice(-120) });
});
router.get("/evolution/agents", (_req, res) => {
  res.json(evolution.agents().map((a) => ({ ...a, capitalHistory: a.capitalHistory.slice(-60), fitnessHistory: a.fitnessHistory.slice(-60) })));
});
router.get("/evolution/agents/:id", (req, res) => {
  const a = evolution.agent(String(req.params.id));
  if (!a) return res.status(404).json({ error: "개체 없음" });
  res.json(a);
});
router.get("/evolution/log", (req, res) => {
  res.json(evolution.logs(Number(req.query.limit ?? 100)));
});
router.get("/evolution/lineage", async (_req, res) => {
  try {
    res.json(await evolution.handselLineage());
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});
router.post("/evolution/step", requireSession, async (_req, res) => {
  try {
    res.json(await evolution.step("operator"));
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});
router.post("/evolution/deploy", requireSession, async (_req, res) => {
  try {
    res.json(await evolution.deploySquad("operator deploy"));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});


// ===== 일봉 저장소 — 브라우저가 Upbit를 직접 부르지 않는다 (CORS·레이트리밋·모바일 실패) =====

router.get("/crypto/candles/:market", async (req, res) => {
  const market = String(req.params.market).toUpperCase();
  if (!/^KRW-[A-Z0-9]{2,10}$/.test(market)) return res.status(400).json({ error: "마켓 형식: KRW-BTC" });
  const days = Math.min(400, Math.max(30, Number(req.query.days ?? 200)));
  try {
    res.json(await getDayCandles(market, days));
  } catch (e) {
    res.status(502).json({ error: `Upbit 캔들 실패: ${(e as Error).message}` });
  }
});
router.get("/crypto/candles", (_req, res) => {
  res.json({ ...candleStoreStatus(), rate: upbitRateStatus() });
});

// ===== 제어 평면 — 하나의 목표 포트폴리오 =====

router.get("/control", (_req, res) => {
  res.json(controlPlane.status());
});
router.post("/control/autopilot", requireSession, (req, res) => { controlPlane.setAutopilot(Boolean(req.body?.on)); res.json({ ok: true }); });
router.post("/control/approve", requireSession, async (_req, res) => {
  try { res.json(await controlPlane.approve()); } catch (e) { res.status(409).json({ error: (e as Error).message }); }
});
router.post("/control/reject", requireSession, (_req, res) => {
  try { res.json(controlPlane.reject()); } catch (e) { res.status(409).json({ error: (e as Error).message }); }
});
router.post("/control/engines/:id", requireSession, (req, res) => {
  try { controlPlane.setEngine(String(req.params.id) as EngineId, { enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined, weight: typeof req.body?.weight === "number" ? req.body.weight : undefined }); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.post("/control/policy", requireSession, (req, res) => { controlPlane.setPolicy(req.body ?? {}); res.json({ ok: true }); });
router.post("/control/arbitrate", requireSession, async (_req, res) => {
  try { res.json(await controlPlane.arbitrate("operator")); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
