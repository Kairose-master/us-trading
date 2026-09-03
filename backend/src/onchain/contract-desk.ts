import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../core/logger.js";
import { analyzeContract, type ContractProfile } from "./contract-risk.js";
import { contractRegistry, type Resolution } from "./registry.js";
import { decodeAddress, decodeUint, decodeUint8, ethCall, getCode, getStorageAt } from "./rpc.js";
import { EIP1967, READ } from "./selectors.js";
import { timelockDesk, type TimelockReport } from "./timelock-desk.js";

/**
 * 컨트랙트 데스크 — 심볼 하나를 온체인에서 읽어 위험 프로필로 만든다.
 * 순수 판정은 contract-risk.ts, 주소 해석은 registry.ts, 여기는 I/O와 캐시.
 *
 * 캐시가 긴 이유(7일): 바이트코드는 업그레이드가 아니면 안 바뀐다. 매매 주기와 무관하다.
 */

const FILE = join(process.cwd(), "data", "onchain", "profiles.json");
const TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * 캐시 스키마 버전. **리포트 모양이 바뀌면 올린다.**
 * 실제로 물린 적이 있다: 타임락 필드를 추가했는데 7일 캐시에 그 필드가 없던 옛 레코드가 남아
 * 프로덕션이 계속 `timelock: null`을 돌려줬다 (`?force=1`로만 정상). TTL은 "오래됐나"만 보고
 * "모양이 맞나"는 안 본다.
 */
const CACHE_VERSION = 2;

export interface ContractReport {
  symbol: string;
  ts: string;
  resolution: Resolution;
  profile: ContractProfile | null;
  /** owner가 타임락인가 + 큐에 든 실행의 eta 캘린더 — 가격이 아닌 **예정** */
  timelock: TimelockReport | null;
  /** 읽지 못한 이유 (resolution이 ok가 아니거나 RPC 실패) */
  error: string | null;
}

interface CacheEntry { at: number; v?: number; data: ContractReport }

class ContractDesk {
  private mem = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<ContractReport>>();

  constructor() {
    try {
      if (!existsSync(FILE)) return;
      let dropped = 0;
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(FILE, "utf-8")) as Record<string, CacheEntry>)) {
        if (v?.v === CACHE_VERSION) this.mem.set(k, v);
        else dropped++;
      }
      if (dropped) logger.info("[onchain] dropped stale-shape profile cache entries", { dropped, version: CACHE_VERSION });
    } catch (e) { logger.warn("[onchain] profile cache read failed", { error: (e as Error).message }); }
  }
  private save() {
    try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(Object.fromEntries(this.mem))); }
    catch (e) { logger.warn("[onchain] profile cache write failed", { error: (e as Error).message }); }
  }

  async report(symbol: string, force = false): Promise<ContractReport> {
    const key = symbol.replace(/^KRW-/, "").toUpperCase();
    const hit = this.mem.get(key);
    if (!force && hit && hit.v === CACHE_VERSION && Date.now() - hit.at < TTL_MS) return hit.data;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.build(key).then((data) => { this.mem.set(key, { at: Date.now(), v: CACHE_VERSION, data }); this.save(); return data; }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async build(symbol: string): Promise<ContractReport> {
    const ts = new Date().toISOString();
    const resolution = await contractRegistry.resolve(symbol);
    if (resolution.status !== "ok" || !resolution.address || !resolution.chain) {
      return { symbol, ts, resolution, profile: null, timelock: null, error: resolution.note };
    }
    const { chain, address } = resolution;
    try {
      const [codeHex, implSlot, ownerRaw, getOwnerRaw, supplyRaw, decimalsRaw] = await Promise.all([
        getCode(chain, address),
        getStorageAt(chain, address, EIP1967.implementation).catch(() => null),
        ethCall(chain, address, READ.owner),
        ethCall(chain, address, READ.getOwner),
        ethCall(chain, address, READ.totalSupply),
        ethCall(chain, address, READ.decimals),
      ]);
      const implAddr = decodeAddress(implSlot) ?? decodeAddress(await ethCall(chain, address, READ.implementation));
      const implCodeHex = implAddr ? await getCode(chain, implAddr).catch(() => null) : null;
      const profile = analyzeContract({
        symbol, chain, address, codeHex,
        eip1967Impl: implSlot,
        owner: decodeAddress(ownerRaw) ?? decodeAddress(getOwnerRaw),
        totalSupply: decodeUint(supplyRaw),
        decimals: decodeUint8(decimalsRaw),
        implCodeHex,
      });
      logger.info("[onchain] contract profile", { symbol, chain, severity: profile.severity, proxy: profile.proxy.isProxy, findings: profile.findings.length });
      // owner가 타임락이면 특권 행사에 공표된 지연이 붙는다 — 그 사실과 큐에 든 eta를 같이 싣는다
      const timelock = await timelockDesk
        .report({ symbol, chain, owner: profile.owner, ownerIsZero: profile.ownerIsZero, proxyAdmin: profile.proxy.implementation })
        .catch((e) => { logger.warn("[onchain] timelock report failed", { symbol, error: (e as Error).message.slice(0, 120) }); return null; });
      return { symbol, ts, resolution, profile, timelock, error: null };
    } catch (e) {
      return { symbol, ts, resolution, profile: null, timelock: null, error: `온체인 읽기 실패: ${(e as Error).message.slice(0, 160)}` };
    }
  }

  /** 여러 심볼 — 순차(공개 RPC 예의) */
  async reports(symbols: string[], force = false): Promise<ContractReport[]> {
    const out: ContractReport[] = [];
    for (const s of symbols) out.push(await this.report(s, force));
    return out;
  }
}

export const contractDesk = new ContractDesk();
