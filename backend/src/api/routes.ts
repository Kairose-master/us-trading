import { Router } from "express";
import { z } from "zod";
import { state } from "./state.js";
import { riskManager } from "../risk/riskManager.js";
import { engine } from "../strategy/engine.js";
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
import { upbit } from "../crypto/upbit.js";
import { runBacktest, SIGNALS } from "../crypto/backtest.js";
import { walkForwardValidate } from "../ml/validate.js";
import { DEFAULT_PARAMS } from "../ml/train.js";
import { tuneHyperparams } from "../ml/tune.js";
import { buildQuantReport } from "../quant/report.js";
import type { Exchange, Order } from "../kis/types.js";

export const router = Router();

// ===== 계좌 =====

router.get("/account/balance", (_req, res) => {
  res.json(state.balance);
});

router.get("/account/positions", (_req, res) => {
  res.json(state.positions);
});

// ===== 시세 =====

router.get("/quotes/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const q = state.quotes.get(symbol);
  if (q) return res.json(q);
  if (config.MOCK_DATA) {
    return res.json(state.ensureQuote(symbol, symbol, "NAS", 100));
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

// ===== 전략 =====

router.get("/strategies", (_req, res) => {
  res.json(
    [...engine.strategies.values()].map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      todayPnlUsd: s.todayPnlUsd,
      positionCount: s.positionCount,
      config: s.config,
    }))
  );
});

router.post("/strategies/:id/start", (req, res) => {
  try {
    engine.start(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.post("/strategies/:id/stop", (req, res) => {
  try {
    engine.stop(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.patch("/strategies/:id/config", (req, res) => {
  const s = engine.strategies.get(req.params.id);
  if (!s) return res.status(404).json({ error: "전략 없음" });
  s.config = { ...s.config, ...req.body };
  res.json({ ok: true });
});

router.get("/strategies/:id/logs", (req, res) => {
  const s = engine.strategies.get(req.params.id);
  if (!s) return res.status(404).json({ error: "전략 없음" });
  const limit = Number(req.query.limit ?? 100);
  res.json(s.logs.slice(-limit).reverse());
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
  const stoppedStrategies = engine.stopAll();
  res.json({ ok: true, stoppedStrategies });
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

router.post("/crypto/autotrade", (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled: boolean 필요" });
  const err = cryptoDesk.setTrade(enabled);
  if (err) return res.status(409).json({ error: err });
  res.json(cryptoDesk.status());
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
