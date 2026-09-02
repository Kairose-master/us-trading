import { EventEmitter } from "node:events";
import { logger } from "./logger.js";

/**
 * 수집 감독자(self-healing orchestrator) — 모든 외부 데이터 소스(Yahoo 시세, Upbit 시세,
 * 뉴스 RSS)는 자기 setInterval 대신 여기 등록되고, 여기서 돈다.
 *
 *   - 실패하면 지수 백오프로 재시도한다 (1.5s → 3s → 6s … 최대 30s, ±20% 지터)
 *   - 3회 연속 실패면 FAILED, 그 전은 DEGRADED. 성공하면 HEALTHY로 돌아온다
 *   - 회복하면 백필한다: 소스가 replay 가능하면(뉴스 RSS, Upbit 캔들) 놓친 구간을
 *     실제로 다시 받아 흘리고, 불가능하면(Yahoo 지연 시세, 호가 스냅샷) 그렇다고 적는다
 *   - BREAK NODE는 진짜 장애 주입이다: 그 소스의 run이 실제로 실패하고, 감독자가 실제로
 *     재시도·회복·백필한다. 화면의 "self-healing"은 이 실제 동작을 보여주는 것이다
 *   - 모든 결정이 오케스트레이터 로그로 남는다 (링 버퍼 300줄)
 *
 * 숫자(rows/s·lag·backoff·attempt)는 전부 실측이다.
 */

export type SourceStatus = "healthy" | "degraded" | "failed" | "paused" | "broken";
export type Market = "us" | "crypto" | "all";

export interface SourceDef {
  id: string;
  name: string;
  market: Market;
  /** 이 소스가 파이프라인의 어느 노드로 들어가는지 (모니터 그래프가 상태를 입힌다) */
  feedsNode: string;
  intervalMs: number;
  /** lag(마지막 성공 이후 경과)이 이 값을 넘으면 SLA 위반으로 표시 */
  slaMs: number;
  /** 한 번의 수집 — 처리한 행 수를 돌려주고, 실패면 throw */
  run: () => Promise<{ rows: number; note?: string }>;
  /** 회복 후 백필 — 마지막 성공 시각 이후를 실제로 다시 받는다. 없으면 replay 불가 소스 */
  backfill?: (sinceIso: string) => Promise<{ rows: number; note: string }>;
}

export interface OpsLogLine {
  ts: string;
  source: string;
  level: "info" | "ok" | "warn" | "error";
  message: string;
}

export interface SourceState {
  id: string;
  name: string;
  market: Market;
  feedsNode: string;
  status: SourceStatus;
  intervalMs: number;
  slaMs: number;
  replayable: boolean;
  consecutiveFailures: number;
  attempt: number;
  backoffMs: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lagMs: number;
  rowsTotal: number;
  rowsPerSec: number;
  failures: number;
  recoveries: number;
  brokenUntil: string | null;
  inFlight: boolean;
}

interface Runtime {
  def: SourceDef;
  status: SourceStatus;
  consecutiveFailures: number;
  attempt: number;
  backoffMs: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  rowsTotal: number;
  window: Array<[number, number]>; // [ts, rows]
  failures: number;
  recoveries: number;
  brokenUntil: number | null;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  wasFailing: boolean;
}

const BASE_BACKOFF_MS = 1_500;
const MAX_BACKOFF_MS = 30_000; // 데이터 파이프라인은 신선도가 우선 — 상한을 짧게
const FAILED_AFTER = 3;
const LOG_MAX = 300;

class Supervisor extends EventEmitter {
  private rts = new Map<string, Runtime>();
  private logLines: OpsLogLine[] = [];
  paused = false;
  autoRecovery = true;

  register(def: SourceDef) {
    if (this.rts.has(def.id)) return;
    const rt: Runtime = { def, status: "healthy", consecutiveFailures: 0, attempt: 0, backoffMs: 0, nextRunAt: null, lastRunAt: null, lastSuccessAt: null, lastError: null, rowsTotal: 0, window: [], failures: 0, recoveries: 0, brokenUntil: null, timer: null, inFlight: false, wasFailing: false };
    this.rts.set(def.id, rt);
    this.log(def.id, "info", `registered — every ${(def.intervalMs / 1000).toFixed(0)}s · sla ${(def.slaMs / 1000).toFixed(0)}s · ${def.backfill ? "replayable" : "not replayable"}`);
    this.schedule(rt, 500);
  }

  private schedule(rt: Runtime, delayMs: number) {
    if (rt.timer) clearTimeout(rt.timer);
    rt.nextRunAt = Date.now() + delayMs;
    rt.timer = setTimeout(() => void this.tick(rt), delayMs);
    rt.timer.unref();
  }

  private async tick(rt: Runtime) {
    if (rt.inFlight) return;
    if (this.paused) {
      rt.status = "paused";
      this.schedule(rt, rt.def.intervalMs);
      this.emitSnapshot();
      return;
    }
    rt.inFlight = true;
    rt.lastRunAt = Date.now();
    this.emitSnapshot();
    try {
      if (rt.brokenUntil && Date.now() < rt.brokenUntil) {
        rt.status = "broken";
        throw new Error(`injected fault (BREAK NODE) — ${Math.ceil((rt.brokenUntil - Date.now()) / 1000)}s left`);
      }
      if (rt.brokenUntil && Date.now() >= rt.brokenUntil) rt.brokenUntil = null;
      const r = await rt.def.run();
      this.onSuccess(rt, r.rows, r.note);
      this.schedule(rt, rt.def.intervalMs);
    } catch (e) {
      this.onFailure(rt, (e as Error).message);
      this.schedule(rt, this.autoRecovery ? rt.backoffMs : rt.def.intervalMs);
    } finally {
      rt.inFlight = false;
      this.emitSnapshot();
    }
  }

  private onSuccess(rt: Runtime, rows: number, note?: string) {
    const now = Date.now();
    const wasFailing = rt.consecutiveFailures > 0;
    const lagBefore = rt.lastSuccessAt ? now - rt.lastSuccessAt : 0;
    const sinceIso = rt.lastSuccessAt ? new Date(rt.lastSuccessAt).toISOString() : null;
    rt.lastSuccessAt = now;
    rt.lastError = null;
    rt.rowsTotal += rows;
    rt.window.push([now, rows]);
    rt.window = rt.window.filter(([t]) => now - t < 10_000);
    if (wasFailing) {
      rt.recoveries++;
      const attempts = rt.consecutiveFailures;
      rt.consecutiveFailures = 0;
      rt.attempt = 0;
      rt.backoffMs = 0;
      rt.status = "healthy";
      this.log(rt.def.id, "ok", `recovered on retry ${attempts} — ${rows} rows live${note ? ` · ${note}` : ""}`);
      // 백필: 놓친 구간을 실제로 다시 받는다 (가능한 소스만)
      if (rt.def.backfill && sinceIso) {
        void rt.def.backfill(sinceIso).then(
          (b) => { rt.rowsTotal += b.rows; this.log(rt.def.id, "ok", `backfill — replayed ${b.rows} rows since ${sinceIso.slice(11, 19)}Z · ${b.note}`); this.emitSnapshot(); },
          (e) => this.log(rt.def.id, "warn", `backfill failed — ${(e as Error).message}`),
        );
      } else {
        this.log(rt.def.id, "info", `no backfill — ${rt.def.backfill ? "no gap to replay" : "this source is not replayable; resumed live"}`);
      }
      if (lagBefore > rt.def.slaMs) this.log(rt.def.id, "ok", `healthy again — lag ${(lagBefore / 1000).toFixed(1)}s was outside sla ${(rt.def.slaMs / 1000).toFixed(0)}s, back inside`);
    } else {
      rt.status = "healthy";
    }
  }

  private onFailure(rt: Runtime, message: string) {
    rt.consecutiveFailures++;
    rt.failures++;
    rt.attempt = rt.consecutiveFailures;
    rt.lastError = message;
    const raw = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (rt.consecutiveFailures - 1));
    rt.backoffMs = Math.round(raw * (0.8 + Math.random() * 0.4));
    if (rt.status !== "broken") rt.status = rt.consecutiveFailures >= FAILED_AFTER ? "failed" : "degraded";
    if (rt.consecutiveFailures === 1) this.log(rt.def.id, "error", `FAILED — ${message}`);
    this.log(rt.def.id, "warn", `retry ${rt.consecutiveFailures} failed — backing off ${(rt.backoffMs / 1000).toFixed(1)}s${rt.consecutiveFailures >= FAILED_AFTER ? " · status FAILED" : ""}`);
  }

  /** 진짜 장애 주입 — 그 소스의 다음 실행들이 실제로 실패한다 */
  breakSource(id: string, seconds: number) {
    const rt = this.rts.get(id);
    if (!rt) throw new Error(`unknown source ${id}`);
    const s = Math.max(5, Math.min(600, Math.round(seconds)));
    rt.brokenUntil = Date.now() + s * 1000;
    rt.status = "broken";
    this.log(id, "warn", `BREAK NODE — fault injected for ${s}s (operator action); the next runs will really fail`);
    this.schedule(rt, 300);
    this.emitSnapshot();
  }

  /** 장애 주입 해제 + 실패 중인 소스 즉시 재시도 */
  healAll() {
    let n = 0;
    for (const rt of this.rts.values()) {
      if (rt.brokenUntil) { rt.brokenUntil = null; n++; }
      if (rt.consecutiveFailures > 0 || rt.status === "broken") { this.schedule(rt, 200); n++; }
    }
    this.log("supervisor", "info", `HEAL ALL — cleared injected faults, forced ${n} immediate retries (operator action)`);
    this.emitSnapshot();
  }

  pause() {
    this.paused = true;
    for (const rt of this.rts.values()) rt.status = "paused";
    this.log("supervisor", "warn", "PAUSED — all sources stopped by operator; nothing is invented while paused");
    this.emitSnapshot();
  }

  resume() {
    this.paused = false;
    for (const rt of this.rts.values()) { rt.status = rt.consecutiveFailures > 0 ? "degraded" : "healthy"; this.schedule(rt, 300); }
    this.log("supervisor", "info", "RESUMED — all sources rescheduled");
    this.emitSnapshot();
  }

  setAutoRecovery(on: boolean) {
    this.autoRecovery = on;
    this.log("supervisor", on ? "info" : "warn", on ? "auto-recovery ON — retries with exponential backoff, then backfill" : "auto-recovery OFF — failures wait a full interval, no backoff");
    this.emitSnapshot();
  }

  private log(source: string, level: OpsLogLine["level"], message: string) {
    const line: OpsLogLine = { ts: new Date().toISOString(), source, level, message };
    this.logLines.unshift(line);
    if (this.logLines.length > LOG_MAX) this.logLines.length = LOG_MAX;
    (level === "error" ? logger.warn : logger.info)(`[supervisor:${source}] ${message}`);
    this.emit("log", line);
  }

  private emitSnapshot() {
    this.emit("snapshot", this.snapshot());
  }

  state(rt: Runtime): SourceState {
    const now = Date.now();
    const win = rt.window.filter(([t]) => now - t < 10_000);
    const rows = win.reduce((a, [, r]) => a + r, 0);
    const span = win.length ? Math.max(1, (now - win[0][0]) / 1000) : 10;
    return {
      id: rt.def.id, name: rt.def.name, market: rt.def.market, feedsNode: rt.def.feedsNode,
      status: this.paused ? "paused" : rt.status,
      intervalMs: rt.def.intervalMs, slaMs: rt.def.slaMs, replayable: Boolean(rt.def.backfill),
      consecutiveFailures: rt.consecutiveFailures, attempt: rt.attempt, backoffMs: rt.backoffMs,
      nextRunAt: rt.nextRunAt ? new Date(rt.nextRunAt).toISOString() : null,
      lastRunAt: rt.lastRunAt ? new Date(rt.lastRunAt).toISOString() : null,
      lastSuccessAt: rt.lastSuccessAt ? new Date(rt.lastSuccessAt).toISOString() : null,
      lastError: rt.lastError,
      lagMs: rt.lastSuccessAt ? now - rt.lastSuccessAt : 0,
      rowsTotal: rt.rowsTotal, rowsPerSec: +(rows / Math.max(span, 1)).toFixed(2),
      failures: rt.failures, recoveries: rt.recoveries,
      brokenUntil: rt.brokenUntil ? new Date(rt.brokenUntil).toISOString() : null,
      inFlight: rt.inFlight,
    };
  }

  snapshot(market?: Market) {
    const sources = [...this.rts.values()].map((rt) => this.state(rt)).filter((s) => !market || market === "all" || s.market === market || s.market === "all");
    return {
      ts: new Date().toISOString(),
      paused: this.paused,
      autoRecovery: this.autoRecovery,
      healthy: sources.filter((s) => s.status === "healthy").length,
      total: sources.length,
      failing: sources.filter((s) => s.status === "failed" || s.status === "broken").length,
      sources,
    };
  }

  logs(limit = 100, market?: Market): OpsLogLine[] {
    const ids = market && market !== "all" ? new Set([...this.rts.values()].filter((r) => r.def.market === market || r.def.market === "all").map((r) => r.def.id).concat(["supervisor"])) : null;
    return this.logLines.filter((l) => !ids || ids.has(l.source)).slice(0, limit);
  }
}

export const supervisor = new Supervisor();
