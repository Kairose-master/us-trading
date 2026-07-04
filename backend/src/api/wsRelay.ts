import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { state } from "./state.js";
import { kisWs } from "../kis/ws.js";
import { config } from "../config.js";
import { logger } from "../core/logger.js";

/**
 * 프론트용 WebSocket 릴레이 (/ws/live).
 * 클라이언트가 { subscribe: ["quote:GME", "execution", ...] } 를 보내면
 * 해당 채널의 이벤트를 { ch, data } 형태로 중계한다.
 */
export function attachWsRelay(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws/live" });
  const subs = new Map<WebSocket, Set<string>>();

  wss.on("connection", (ws) => {
    subs.set(ws, new Set());
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (Array.isArray(msg.subscribe)) {
          const set = subs.get(ws)!;
          for (const ch of msg.subscribe) {
            set.add(ch);
            // quote:SYMBOL 구독이면 KIS 쪽에도 구독 전파 (실모드)
            if (ch.startsWith("quote:") && !config.MOCK_DATA) {
              const symbol = ch.split(":")[1];
              const pos = state.positions.find((p) => p.symbol === symbol);
              kisWs.subscribe(symbol, pos?.exch ?? "NAS");
            }
          }
        }
      } catch {
        // 무시
      }
    });
    ws.on("close", () => subs.delete(ws));
  });

  function broadcast(ch: string, data: unknown) {
    const payload = JSON.stringify({ ch, data });
    for (const [ws, set] of subs) {
      if (set.has(ch) && ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // 상태 저장소/KIS WS 이벤트 → 프론트 릴레이
  state.on("tick", (q) => broadcast(`quote:${q.symbol}`, {
    last: q.last, change: q.change, changePct: q.changePct, bid: q.bid, ask: q.ask, volume: q.volume, ts: new Date().toISOString(),
  }));
  state.on("position", (positions) => broadcast("position", positions));
  state.on("execution", (e) => broadcast("execution", e));

  kisWs.on("tick", (t) => {
    const q = state.quotes.get(t.symbol);
    if (q) {
      q.last = t.last;
      q.change = t.change;
      q.changePct = t.changePct;
      q.volume = t.volume;
      state.refreshPositionPrices();
    }
    broadcast(`quote:${t.symbol}`, t);
  });

  logger.info("WS relay attached at /ws/live");
}
