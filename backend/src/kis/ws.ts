import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { KIS, EXCH_CODE } from "./endpoints.js";
import { tokenManager } from "./auth.js";
import { logger } from "../core/logger.js";
import type { Exchange } from "./types.js";

/**
 * KIS 실시간 WebSocket 소비자.
 * - approval_key로 접속, 종목별 체결가(HDFSCNT0) 구독
 * - 파이프(^) 구분 텍스트 프레임을 파싱해 'tick' 이벤트로 방출
 * - 끊기면 지수 백오프 재연결 + 기존 구독 복구
 *
 * 이벤트: emit("tick", { symbol, last, change, changePct, volume, ts })
 *         emit("status", "connected" | "reconnecting" | "disconnected")
 */
class KisWsConsumer extends EventEmitter {
  private ws: WebSocket | null = null;
  private subs = new Set<string>(); // "EXCH:SYMBOL"
  private backoff = 1000;
  status: "connected" | "reconnecting" | "disconnected" = "disconnected";

  async connect() {
    if (config.MOCK_DATA) return; // 목모드에서는 연결 안 함
    const approvalKey = await tokenManager.getWsApprovalKey();
    this.ws = new WebSocket(config.kisWsUrl);

    this.ws.on("open", () => {
      this.backoff = 1000;
      this.setStatus("connected");
      // 재연결 시 기존 구독 복구
      for (const key of this.subs) this.sendSubscribe(key, approvalKey);
    });

    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));

    this.ws.on("close", () => {
      this.setStatus("reconnecting");
      setTimeout(() => this.connect().catch(() => {}), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });

    this.ws.on("error", (e) => logger.error("KIS WS error", { message: e.message }));
  }

  private setStatus(s: typeof this.status) {
    this.status = s;
    this.emit("status", s);
  }

  subscribe(symbol: string, exch: Exchange) {
    const key = `${exch}:${symbol}`;
    if (this.subs.has(key)) return;
    this.subs.add(key);
    if (this.ws?.readyState === WebSocket.OPEN) {
      tokenManager.getWsApprovalKey().then((k) => this.sendSubscribe(key, k));
    }
  }

  private sendSubscribe(key: string, approvalKey: string) {
    const [exch, symbol] = key.split(":") as [Exchange, string];
    // 미국 실시간(지연)체결가 tr_key 형식: D + 시장코드(3) + 심볼  (예: DNASAAPL) — 문서 대조 필요
    const trKey = `D${EXCH_CODE.quote[exch]}${symbol}`;
    this.ws?.send(
      JSON.stringify({
        header: { approval_key: approvalKey, custtype: "P", tr_type: "1", "content-type": "utf-8" },
        body: { input: { tr_id: KIS.wsTrade.trId, tr_key: trKey } },
      })
    );
  }

  private handleMessage(msg: string) {
    // 실데이터 프레임은 "0|HDFSCNT0|001|D..." 형태, 필드는 ^ 구분
    if (!msg.startsWith("0|") && !msg.startsWith("1|")) return; // JSON 응답(구독확인/핑)은 무시
    const parts = msg.split("|");
    const trId = parts[1];
    if (trId !== KIS.wsTrade.trId) return;
    const fields = (parts[3] ?? "").split("^");
    // ✅ HDFSCNT0 필드 순서 — 공식 샘플 대조 검증 완료:
    // 0:SYMB 1:ZDIV 2:TYMD 3:XYMD 4:XHMS 5:KYMD 6:KHMS 7:OPEN 8:HIGH 9:LOW
    // 10:LAST 11:SIGN 12:DIFF 13:RATE 14:PBID 15:PASK 16:VBID 17:VASK 18:EVOL 19:TVOL
    const symbolField = fields[0] ?? ""; // 예: DNASAAPL (D + 시장3자리 + 심볼)
    const symbol = symbolField.slice(4);
    const last = parseFloat(fields[10] ?? "0");
    // SIGN: 1/2 상승, 3 보합, 4/5 하락 — DIFF/RATE는 부호 없는 값이라 방향 적용
    const sign = fields[11] === "4" || fields[11] === "5" ? -1 : 1;
    const change = sign * parseFloat(fields[12] ?? "0");
    const changePct = sign * parseFloat(fields[13] ?? "0");
    const bid = parseFloat(fields[14] ?? "0");
    const ask = parseFloat(fields[15] ?? "0");
    const volume = parseInt(fields[19] ?? "0", 10);
    if (!symbol || !isFinite(last)) return;
    this.emit("tick", { symbol, last, change, changePct, bid, ask, volume, ts: new Date().toISOString() });
  }
}

export const kisWs = new KisWsConsumer();
