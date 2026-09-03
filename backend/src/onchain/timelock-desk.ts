import { logger } from "../core/logger.js";
import { ethCall, getCode, getLogs, type Log } from "./rpc.js";
import {
  ALL_TOPICS, buildCalendar, classifyOwner, decodeScheduled, keysOf, ownerMultiplier,
  TIMELOCK_READ, TIMELOCK_TOPICS, type CalendarEntry, type OwnerKind, type ScheduledCall,
} from "./timelock.js";

/**
 * 타임락 데스크 — 토큰의 특권 주소가 거버넌스 타임락인지 찾아내고, 큐에 든 실행을 eta 캘린더로 만든다.
 *
 * 레지스트리를 손으로 관리하지 않는다: 토큰의 `owner()`(그리고 프록시 관리자)가 후보이고,
 * 그 주소에서 타임락 이벤트가 실제로 나오는지 확인해서 판별한다. 나오지 않으면 "타임락 아님"이라고
 * 적을 뿐 추측하지 않는다.
 */

const WINDOW_BLOCKS = 200_000; // 이더리움 ≈ 28일. 타임락 지연(보통 2~7일)을 넉넉히 덮는다
const CANDIDATE_MIN_CODE = 2;

export interface TimelockInfo {
  address: string;
  family: "compound" | "oz" | "unknown";
  delaySec: number | null;
  scheduledSeen: number;
  window: { fromBlock: number; toBlock: number };
}

export interface TimelockReport {
  symbol: string;
  chain: string;
  ts: string;
  owner: { address: string | null; kind: OwnerKind; note: string; multiplier: number };
  timelock: TimelockInfo | null;
  calendar: CalendarEntry[];
  /** 지금 살아있는 예정 (pending + executable) */
  live: number;
  error: string | null;
}

async function readDelay(chain: string, addr: string): Promise<{ family: TimelockInfo["family"]; delaySec: number | null }> {
  const oz = await ethCall(chain, addr, TIMELOCK_READ.getMinDelay);
  if (oz && oz !== "0x") { try { return { family: "oz", delaySec: Number(BigInt(oz)) }; } catch { /* fall through */ } }
  const comp = await ethCall(chain, addr, TIMELOCK_READ.delay);
  if (comp && comp !== "0x") { try { return { family: "compound", delaySec: Number(BigInt(comp)) }; } catch { /* fall through */ } }
  return { family: "unknown", delaySec: null };
}

/** 큐에 든 키의 현재 상태를 컨트랙트에 직접 물어본다 — 로그만 보면 놓치는 취소·실행을 잡는다 */
async function resolveOnchain(chain: string, timelock: string, calls: ScheduledCall[]): Promise<Record<string, { etaSec: number | null; done: boolean }>> {
  const out: Record<string, { etaSec: number | null; done: boolean }> = {};
  const uniq = [...new Map(calls.map((c) => [c.key.toLowerCase(), c])).values()].slice(0, 25);
  for (const c of uniq) {
    const key = c.key.replace(/^0x/, "").padStart(64, "0");
    if (c.family === "oz") {
      const r = await ethCall(chain, timelock, TIMELOCK_READ.getTimestamp + key);
      if (!r || r === "0x") continue;
      let n = 0;
      try { n = Number(BigInt(r)); } catch { continue; }
      // OZ: 0 미등록 · 1 = _DONE_TIMESTAMP(완료 표시, 시각이 아니다) · 그 외 eta
      out[c.key.toLowerCase()] = n === 0 ? { etaSec: null, done: false } : n === 1 ? { etaSec: null, done: true } : { etaSec: n, done: false };
    } else {
      const r = await ethCall(chain, timelock, TIMELOCK_READ.queuedTransactions + key);
      if (!r || r === "0x") continue;
      let queued = false;
      try { queued = BigInt(r) === 1n; } catch { queued = false; }
      out[c.key.toLowerCase()] = { etaSec: c.etaSec, done: !queued };
    }
  }
  return out;
}

class TimelockDesk {
  private cache = new Map<string, { at: number; data: TimelockReport }>();
  private ttlMs = 60 * 60_000; // 큐에 든 트랜잭션은 자주 바뀌지 않는다

  async report(p: { symbol: string; chain: string; owner: string | null; ownerIsZero: boolean; proxyAdmin?: string | null }, force = false): Promise<TimelockReport> {
    const key = `${p.chain}:${p.symbol}`.toUpperCase();
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    const data = await this.build(p);
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  private async build(p: { symbol: string; chain: string; owner: string | null; ownerIsZero: boolean; proxyAdmin?: string | null }): Promise<TimelockReport> {
    const ts = new Date().toISOString();
    const nowSec = Math.floor(Date.now() / 1000);
    const empty = (kind: OwnerKind, note: string, error: string | null = null): TimelockReport => ({
      symbol: p.symbol, chain: p.chain, ts,
      owner: { address: p.owner, kind, note, multiplier: ownerMultiplier(kind) },
      timelock: null, calendar: [], live: 0, error,
    });

    const candidates = [p.owner, p.proxyAdmin].filter((x): x is string => Boolean(x));
    if (candidates.length === 0) {
      const c = classifyOwner({ owner: p.owner, ownerIsZero: p.ownerIsZero, codeBytes: 0, timelockEvents: 0, delaySec: null });
      return empty(c.kind, c.note);
    }

    for (const addr of candidates) {
      let codeBytes = 0;
      try { codeBytes = Math.floor(((await getCode(p.chain, addr)) || "0x").replace(/^0x/, "").length / 2); }
      catch (e) { return empty("none", "owner의 코드를 못 읽었다", `getCode 실패: ${(e as Error).message.slice(0, 120)}`); }
      if (codeBytes <= CANDIDATE_MIN_CODE) {
        const c = classifyOwner({ owner: addr, ownerIsZero: p.ownerIsZero, codeBytes, timelockEvents: 0, delaySec: null });
        if (candidates.length === 1) return empty(c.kind, c.note);
        continue;
      }
      let logs: Log[] = [];
      let window = { fromBlock: 0, toBlock: 0 };
      try {
        const r = await getLogs(p.chain, addr, [ALL_TOPICS], WINDOW_BLOCKS);
        logs = r.logs; window = { fromBlock: r.fromBlock, toBlock: r.toBlock };
      } catch (e) {
        const c = classifyOwner({ owner: addr, ownerIsZero: p.ownerIsZero, codeBytes, timelockEvents: 0, delaySec: null });
        return empty(c.kind, c.note, `로그를 못 읽어 타임락인지 확인하지 못했다: ${(e as Error).message.slice(0, 120)}`);
      }
      const scheduled = logs.map(decodeScheduled).filter((x): x is ScheduledCall => Boolean(x));
      const { family, delaySec } = await readDelay(p.chain, addr);
      const isTimelock = scheduled.length > 0 || delaySec !== null;
      if (!isTimelock) {
        const c = classifyOwner({ owner: addr, ownerIsZero: p.ownerIsZero, codeBytes, timelockEvents: 0, delaySec: null });
        if (candidates.length === 1 || addr === candidates[candidates.length - 1]) return empty(c.kind, c.note);
        continue;
      }
      const onchain = await resolveOnchain(p.chain, addr, scheduled);
      const calendar = buildCalendar({
        scheduled,
        executedKeys: new Set([...keysOf(logs, TIMELOCK_TOPICS.compound.execute), ...keysOf(logs, TIMELOCK_TOPICS.oz.executed)]),
        cancelledKeys: new Set([...keysOf(logs, TIMELOCK_TOPICS.compound.cancel), ...keysOf(logs, TIMELOCK_TOPICS.oz.cancelled)]),
        onchain, nowSec,
      });
      const cls = classifyOwner({ owner: addr, ownerIsZero: p.ownerIsZero, codeBytes, timelockEvents: scheduled.length, delaySec });
      const live = calendar.filter((c) => c.status === "pending" || c.status === "executable").length;
      logger.info("[timelock] report", { symbol: p.symbol, chain: p.chain, timelock: addr, family, delaySec, scheduled: scheduled.length, live });
      return {
        symbol: p.symbol, chain: p.chain, ts,
        owner: { address: addr, kind: cls.kind, note: cls.note, multiplier: ownerMultiplier(cls.kind) },
        timelock: { address: addr, family, delaySec, scheduledSeen: scheduled.length, window },
        calendar: calendar.slice(0, 40), live, error: null,
      };
    }
    const c = classifyOwner({ owner: p.owner, ownerIsZero: p.ownerIsZero, codeBytes: 3, timelockEvents: 0, delaySec: null });
    return empty(c.kind, c.note);
  }
}

export const timelockDesk = new TimelockDesk();
