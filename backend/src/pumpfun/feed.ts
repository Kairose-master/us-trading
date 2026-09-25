import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { logger } from "../core/logger.js";

/**
 * PumpPortal 실시간 스트림 (wss://pumpportal.fun/api/data) — pump.fun 프로그램 로그를 직접 디코딩하는 대신
 * 이미 파싱된 이벤트를 받는다. 실측(2026-09-25):
 *   · subscribeNewToken / subscribeMigration — 키 없이 무료
 *   · subscribeTokenTrade / subscribeAccountTrade — **0.02 SOL 이상 충전된 API 키**가 있어야 한다
 *     (없으면 서버가 "only available when connecting with an API key funded…" 메시지를 보낸다 — 그걸 그대로 status에 남긴다)
 *   · 과금 0.01 SOL / 1만 메시지 — 그래서 거래 구독은 좁게 건다 (이주 토큰 + 추종 지갑 + 보유 토큰).
 * 재연결은 지수 백오프, 구독 목록은 재연결 때 다시 보낸다. 모든 이벤트는 정규화해서 emit하고 jsonl에 기록한다.
 */

export type FeedEvent =
  | { kind: "create"; ts: string; mint: string; creator: string; name: string; symbol: string; bondingCurveKey: string; initialBuyTokens: number; initialBuySol: number; vSol: number; vTokens: number; marketCapSol: number; signature: string }
  | { kind: "trade"; ts: string; mint: string; wallet: string; side: "buy" | "sell"; sol: number; tokens: number; newTokenBalance: number; vSol: number; vTokens: number; marketCapSol: number; pool: "pump" | "pump-amm" | string; bondingCurveKey: string | null; signature: string }
  | { kind: "migrate"; ts: string; mint: string; pool: string; signature: string; raw: Record<string, unknown> };

type Raw = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function normalize(raw: Raw, ts = new Date().toISOString()): FeedEvent | null {
  const tx = str(raw.txType);
  if (tx === "create") {
    return { kind: "create", ts, mint: str(raw.mint), creator: str(raw.traderPublicKey), name: str(raw.name), symbol: str(raw.symbol), bondingCurveKey: str(raw.bondingCurveKey), initialBuyTokens: num(raw.initialBuy), initialBuySol: num(raw.solAmount), vSol: num(raw.vSolInBondingCurve), vTokens: num(raw.vTokensInBondingCurve), marketCapSol: num(raw.marketCapSol), signature: str(raw.signature) };
  }
  if (tx === "buy" || tx === "sell") {
    return { kind: "trade", ts, mint: str(raw.mint), wallet: str(raw.traderPublicKey), side: tx, sol: num(raw.solAmount), tokens: num(raw.tokenAmount), newTokenBalance: num(raw.newTokenBalance), vSol: num(raw.vSolInBondingCurve), vTokens: num(raw.vTokensInBondingCurve), marketCapSol: num(raw.marketCapSol), pool: str(raw.pool) || "pump", bondingCurveKey: str(raw.bondingCurveKey) || null, signature: str(raw.signature) };
  }
  if (tx === "migrate" || tx === "migration" || raw.txType === undefined && typeof raw.mint === "string" && typeof raw.pool === "string") {
    return { kind: "migrate", ts, mint: str(raw.mint), pool: str(raw.pool), signature: str(raw.signature), raw };
  }
  return null;
}

export interface FeedStatus { url: string; connected: boolean; since: string | null; reconnects: number; messages: number; events: { create: number; trade: number; migrate: number }; lastMessageAt: string | null; lastError: string | null; metered: { hasKey: boolean; ok: boolean | null; note: string | null }; subscriptions: { tokens: number; accounts: number; newToken: boolean; migration: boolean } }

export class PumpPortalFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = true;
  private backoffMs = 1_000;
  private tokenSubs = new Set<string>();
  private accountSubs = new Set<string>();
  private wantNewToken = false;
  private wantMigration = false;
  private st: FeedStatus;

  constructor(private baseUrl: string, private apiKey: string) {
    super();
    this.st = { url: baseUrl, connected: false, since: null, reconnects: 0, messages: 0, events: { create: 0, trade: 0, migrate: 0 }, lastMessageAt: null, lastError: null, metered: { hasKey: !!apiKey, ok: null, note: apiKey ? null : "no PUMPFUN_API_KEY — token/account trade streams unavailable (new-token + migration only)" }, subscriptions: { tokens: 0, accounts: 0, newToken: false, migration: false } };
  }

  status(): FeedStatus { return { ...this.st, subscriptions: { tokens: this.tokenSubs.size, accounts: this.accountSubs.size, newToken: this.wantNewToken, migration: this.wantMigration } }; }
  get hasKey() { return !!this.apiKey; }

  start() { if (!this.stopped) return; this.stopped = false; this.connect(); }
  stop() { this.stopped = true; this.ws?.close(); this.ws = null; }

  private connect() {
    if (this.stopped) return;
    const url = this.apiKey ? `${this.baseUrl}?api-key=${encodeURIComponent(this.apiKey)}` : this.baseUrl;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      this.st.connected = true; this.st.since = new Date().toISOString(); this.backoffMs = 1_000;
      logger.info("[pumpfun] feed connected", { url: this.baseUrl, key: !!this.apiKey });
      this.resubscribe();
      this.emit("open");
    });
    ws.on("message", (d) => this.onMessage(d.toString()));
    ws.on("error", (e) => { this.st.lastError = e.message; });
    ws.on("close", (code) => {
      this.st.connected = false;
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.st.reconnects += 1;
      const wait = this.backoffMs; this.backoffMs = Math.min(60_000, this.backoffMs * 2);
      logger.warn("[pumpfun] feed closed — reconnecting", { code, waitMs: wait });
      setTimeout(() => this.connect(), wait).unref();
    });
  }

  private send(msg: Record<string, unknown>) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  private resubscribe() {
    if (this.wantNewToken) this.send({ method: "subscribeNewToken" });
    if (this.wantMigration) this.send({ method: "subscribeMigration" });
    if (this.tokenSubs.size) this.send({ method: "subscribeTokenTrade", keys: [...this.tokenSubs] });
    if (this.accountSubs.size) this.send({ method: "subscribeAccountTrade", keys: [...this.accountSubs] });
  }

  subscribeNewToken(on = true) { this.wantNewToken = on; this.send({ method: on ? "subscribeNewToken" : "unsubscribeNewToken" }); }
  subscribeMigration(on = true) { this.wantMigration = on; this.send({ method: on ? "subscribeMigration" : "unsubscribeMigration" }); }
  subscribeTokens(mints: string[]) { const add = mints.filter((m) => m && !this.tokenSubs.has(m)); if (!add.length) return; for (const m of add) this.tokenSubs.add(m); this.send({ method: "subscribeTokenTrade", keys: add }); }
  unsubscribeTokens(mints: string[]) { const del = mints.filter((m) => this.tokenSubs.delete(m)); if (del.length) this.send({ method: "unsubscribeTokenTrade", keys: del }); }
  subscribeAccounts(wallets: string[]) { const add = wallets.filter((w) => w && !this.accountSubs.has(w)); if (!add.length) return; for (const w of add) this.accountSubs.add(w); this.send({ method: "subscribeAccountTrade", keys: add }); }
  unsubscribeAccounts(wallets: string[]) { const del = wallets.filter((w) => this.accountSubs.delete(w)); if (del.length) this.send({ method: "unsubscribeAccountTrade", keys: del }); }
  subscribedTokens() { return [...this.tokenSubs]; }
  subscribedAccounts() { return [...this.accountSubs]; }

  private onMessage(text: string) {
    this.st.messages += 1; this.st.lastMessageAt = new Date().toISOString();
    let raw: Raw;
    try { raw = JSON.parse(text) as Raw; } catch { return; }
    if (typeof raw.message === "string" && raw.txType === undefined) {
      const m = raw.message;
      if (/api key/i.test(m)) { this.st.metered.ok = false; this.st.metered.note = m; logger.warn("[pumpfun] metered subscription refused", { message: m }); }
      else if (/subscribed to .*trade|subscribed to token trade|subscribed to account/i.test(m)) { this.st.metered.ok = true; this.st.metered.note = null; }
      this.emit("notice", m);
      return;
    }
    const ev = normalize(raw);
    if (!ev) return;
    this.st.events[ev.kind] += 1;
    this.emit("event", ev);
  }
}
