/**
 * 타임락 `eta` 캘린더 — 순수 함수.
 *
 * 릴이 말한 "회사가 하반기에 발표 예정이라고 문장으로 써놨다"의 크립토판이 이것이다.
 * 거버넌스 타임락은 실행할 트랜잭션을 **미래 시각(eta)과 함께 큐에 넣고 이벤트로 공표한다.**
 * 숫자(가격)가 아니라 예정(일정)이고, 온체인 1차 자료다.
 *
 * 두 가문:
 *   Compound  QueueTransaction(bytes32 indexed txHash, address indexed target, uint value, string signature, bytes data, uint eta)
 *             — `signature`가 사람이 읽는 **문장**이다 ("_setPendingImplementation(address)"). 비면 calldata 셀렉터를 쓴다.
 *   OZ        CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)
 *             — eta = 그 블록 시각 + delay. 다만 `getTimestamp(id)`가 eta를 직접 주고 완료 여부까지 알려주므로 그걸 쓴다.
 *
 * topic0는 keccak256으로 유도한 뒤 **실제 로그로 검증했다**: ENS TimelockController에서 CallScheduled 2건
 * (지연 172800초 = 정확히 2.0일), Compound식 타임락에서 QueueTransaction 46건이 이 topic으로 나왔다.
 */

import { impactOfSignature, isAdverse, nameOf, type Impact } from "./signatures.js";

export const TIMELOCK_TOPICS = {
  compound: {
    queue: "0x76e2796dc3a81d57b0e8504b647febcbeeb5f4af818e164f11eef8131a6a763f",
    execute: "0xa560e3198060a2f10670c1ec5b403077ea6ae93ca8de1c32b451dc1a943cd6e7",
    cancel: "0x2fffc091a501fd91bfbff27141450d3acb40fb8e6d8382b243ec7a812a3aaf87",
  },
  oz: {
    scheduled: "0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca",
    executed: "0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58",
    cancelled: "0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70",
  },
} as const;

export const TIMELOCK_READ = {
  /** OZ: getTimestamp(bytes32) → 0 미등록 · 1 실행완료 · 그 외 eta */
  getTimestamp: "0xd45c4435",
  /** OZ: getMinDelay() */
  getMinDelay: "0xf27a0c92",
  /** Compound: delay() */
  delay: "0x6a42b8f8",
  /** Compound: queuedTransactions(bytes32) → bool */
  queuedTransactions: "0xf2b06537",
} as const;

export const ALL_TOPICS = [
  TIMELOCK_TOPICS.compound.queue, TIMELOCK_TOPICS.compound.execute, TIMELOCK_TOPICS.compound.cancel,
  TIMELOCK_TOPICS.oz.scheduled, TIMELOCK_TOPICS.oz.executed, TIMELOCK_TOPICS.oz.cancelled,
];

export interface RawLog { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }

export type Family = "compound" | "oz";

export interface ScheduledCall {
  family: Family;
  /** Compound는 txHash, OZ는 operation id */
  key: string;
  /** OZ 배치 안의 순번 */
  index: number | null;
  target: string;
  valueWei: string;
  /** 사람이 읽는 의도 — Compound의 signature 문장, 없으면 셀렉터 표에서 찾은 시그니처, 그래도 없으면 hex */
  intent: string;
  /** 의도를 셀렉터 표에서 실제로 찾았나 — 못 찾았으면 hex를 그대로 보여주고 있다는 뜻 */
  intentKnown: boolean;
  /** 보유자 입장에서 무슨 종류의 예정인가 */
  impact: Impact;
  /** upgrade·supply·freeze — 임박하면 피하고 싶은 종류 */
  adverse: boolean;
  selector: string | null;
  calldataBytes: number;
  /** Compound는 이벤트에 있다. OZ는 delay만 있어 getTimestamp로 채운다 */
  etaSec: number | null;
  delaySec: number | null;
  blockNumber: number;
  txHash: string;
}

const words = (hex: string): string[] => {
  const h = (hex || "").replace(/^0x/, "");
  return Array.from({ length: Math.floor(h.length / 64) }, (_, i) => h.slice(i * 64, (i + 1) * 64));
};
const toAddr = (w: string) => "0x" + w.slice(-40);
const toNum = (w: string) => { try { return Number(BigInt("0x" + w)); } catch { return 0; } };
const toBig = (w: string) => { try { return BigInt("0x" + w).toString(); } catch { return "0"; } };
/** 동적 타입 tail 읽기: [len][bytes…] */
function dynamic(ws: string[], headWord: string): { len: number; hex: string } {
  const off = toNum(headWord) / 32;
  if (!Number.isInteger(off) || off < 0 || off >= ws.length) return { len: 0, hex: "" };
  const len = toNum(ws[off]);
  const body = ws.slice(off + 1).join("");
  return { len, hex: body.slice(0, len * 2) };
}
const NUL = String.fromCharCode(0);
const utf8 = (hex: string) => { try { return Buffer.from(hex, "hex").toString("utf8").split(NUL).join(""); } catch { return ""; } };
const selectorOf = (hex: string) => (hex.length >= 8 ? "0x" + hex.slice(0, 8) : null);

/** Compound QueueTransaction 디코드 */
export function decodeQueueTransaction(log: RawLog): ScheduledCall | null {
  if (log.topics?.[0]?.toLowerCase() !== TIMELOCK_TOPICS.compound.queue) return null;
  const ws = words(log.data);
  if (ws.length < 4 || log.topics.length < 3) return null;
  const sig = dynamic(ws, ws[1]);
  const data = dynamic(ws, ws[2]);
  const signature = utf8(sig.hex);
  const sel = selectorOf(data.hex);
  const known = nameOf(sel);
  // Compound는 이벤트가 문장을 직접 준다. 비어 있으면 셀렉터 표를 보고, 그래도 없으면 hex 그대로 남긴다
  const intent = signature || known?.signature || (sel ? `calldata ${sel}` : "(no signature, no calldata)");
  const impact = signature ? impactOfSignature(signature) : (known?.impact ?? "unknown");
  return {
    family: "compound",
    key: log.topics[1],
    index: null,
    target: toAddr(log.topics[2]),
    valueWei: toBig(ws[0]),
    intent,
    intentKnown: Boolean(signature || known),
    impact,
    adverse: isAdverse(impact),
    selector: sel,
    calldataBytes: data.len,
    etaSec: toNum(ws[3]),
    delaySec: null,
    blockNumber: toNum((log.blockNumber || "0x0").replace(/^0x/, "")),
    txHash: log.transactionHash,
  };
}

/** OZ CallScheduled 디코드 — eta는 delay만으로는 모르니 null로 두고 getTimestamp로 채운다 */
export function decodeCallScheduled(log: RawLog): ScheduledCall | null {
  if (log.topics?.[0]?.toLowerCase() !== TIMELOCK_TOPICS.oz.scheduled) return null;
  const ws = words(log.data);
  if (ws.length < 5 || log.topics.length < 3) return null;
  const data = dynamic(ws, ws[2]);
  const sel = selectorOf(data.hex);
  const known = nameOf(sel);
  // OZ는 calldata만 준다 — 표가 없으면 여기가 0x973821a6처럼 보인다. 모르면 "효과 미확인"이지 "양성"이 아니다
  const impact: Impact = known?.impact ?? (data.len === 0 ? "benign" : "unknown");
  return {
    family: "oz",
    key: log.topics[1],
    index: toNum(log.topics[2].replace(/^0x/, "")),
    target: toAddr(ws[0]),
    valueWei: toBig(ws[1]),
    intent: known?.signature ?? (sel ? `calldata ${sel} (표에 없는 함수)` : "(empty calldata)"),
    intentKnown: Boolean(known),
    impact,
    adverse: isAdverse(impact),
    selector: sel,
    calldataBytes: data.len,
    etaSec: null,
    delaySec: toNum(ws[4]),
    blockNumber: toNum((log.blockNumber || "0x0").replace(/^0x/, "")),
    txHash: log.transactionHash,
  };
}

export function decodeScheduled(log: RawLog): ScheduledCall | null {
  return decodeQueueTransaction(log) ?? decodeCallScheduled(log);
}

/** 로그에서 키 집합만 (실행·취소 대조용) */
export function keysOf(logs: RawLog[], topic: string): Set<string> {
  return new Set(logs.filter((l) => l.topics?.[0]?.toLowerCase() === topic && l.topics[1]).map((l) => l.topics[1].toLowerCase()));
}

export type CalendarStatus = "pending" | "executable" | "executed" | "cancelled" | "expired" | "unknown-eta";

export interface CalendarEntry extends ScheduledCall {
  status: CalendarStatus;
  /** 지금부터 eta까지 남은 시간 (시간 단위, 음수면 지났다) */
  hoursUntil: number | null;
  etaIso: string | null;
}

/**
 * 캘린더 조립.
 * @param graceSec eta를 지났지만 아직 실행되지 않은 것을 "executable"로 볼 유예 (Compound의 GRACE_PERIOD는 14일)
 */
export function buildCalendar(p: {
  scheduled: ScheduledCall[];
  executedKeys?: Set<string>;
  cancelledKeys?: Set<string>;
  /** getTimestamp/queuedTransactions로 확인한 상태: key → { etaSec, done }. 완료된 것의 etaSec는 null이다 (OZ의 1은 시각이 아니라 완료 표시다) */
  onchain?: Record<string, { etaSec: number | null; done: boolean }>;
  nowSec: number;
  graceSec?: number;
}): CalendarEntry[] {
  const grace = p.graceSec ?? 14 * 86_400;
  const exec = p.executedKeys ?? new Set<string>();
  const canc = p.cancelledKeys ?? new Set<string>();
  const out: CalendarEntry[] = [];
  for (const s of p.scheduled) {
    const k = s.key.toLowerCase();
    const chain = p.onchain?.[k];
    const eta = s.etaSec ?? chain?.etaSec ?? null;
    let status: CalendarStatus;
    if (canc.has(k)) status = "cancelled";
    else if (exec.has(k) || chain?.done) status = "executed";
    else if (eta === null) status = "unknown-eta";
    else if (eta > p.nowSec) status = "pending";
    // OZ TimelockController는 만료가 없다 — 실행되거나 취소될 때까지 계속 실행 가능하다.
    // Compound식은 GRACE_PERIOD(기본 14일)를 지나면 죽는다. 가문마다 다른 규칙을 하나로 뭉개지 않는다
    else if (s.family === "oz" || eta + grace > p.nowSec) status = "executable";
    else status = "expired";
    out.push({
      ...s,
      etaSec: eta,
      status,
      etaIso: eta ? new Date(eta * 1000).toISOString() : null,
      hoursUntil: eta ? +((eta - p.nowSec) / 3600).toFixed(1) : null,
    });
  }
  // 살아있는 것이 먼저, 그 안에서 가까운 eta가 먼저
  const rank = (s: CalendarStatus) => (s === "executable" ? 0 : s === "pending" ? 1 : s === "unknown-eta" ? 2 : 3);
  return out.sort((a, b) => rank(a.status) - rank(b.status) || (a.etaSec ?? Infinity) - (b.etaSec ?? Infinity));
}

export type OwnerKind = "none" | "renounced" | "eoa" | "contract" | "timelock";

/**
 * owner 분류 — 컨트랙트 프로필이 "멀티시그·타임락인지는 알 수 없다"고 적어 둔 것을 실제로 판별한다.
 * 타임락이면 특권 행사에 **공표된 지연**이 붙는다. EOA면 예고 없이 즉시 가능하다.
 */
export function classifyOwner(p: { owner: string | null; ownerIsZero: boolean; codeBytes: number; timelockEvents: number; delaySec: number | null }): { kind: OwnerKind; note: string } {
  if (p.ownerIsZero) return { kind: "renounced", note: "owner가 0 — 소유권이 포기됐다" };
  if (!p.owner) return { kind: "none", note: "owner()가 없다 — 이 패턴으로는 특권 주소를 찾지 못했다 (역할 기반일 수 있다)" };
  if (p.timelockEvents > 0 || p.delaySec !== null) {
    const d = p.delaySec ? `${(p.delaySec / 86400).toFixed(1)}일` : "미확인";
    return { kind: "timelock", note: `owner가 거버넌스 타임락이다 (지연 ${d}, 최근 예약 ${p.timelockEvents}건) — 특권 행사에 공표된 대기시간이 붙는다` };
  }
  if (p.codeBytes <= 2) return { kind: "eoa", note: "owner에 코드가 없다 — EOA(개인키)다. 예고 없이 즉시 특권을 쓸 수 있다" };
  return { kind: "contract", note: `owner가 컨트랙트다 (${p.codeBytes}B) — 타임락 이벤트가 없어 멀티시그·커스텀인지 이 스캔으로는 구분하지 못한다` };
}

/** owner 종류 → 노출 배수. 타임락이면 벌점이 없다 (예고가 있으니) */
export function ownerMultiplier(kind: OwnerKind): number {
  return kind === "eoa" ? 0.7 : kind === "contract" ? 0.85 : 1;
}

/**
 * 임박한 불리한 예정 — "카탈리스트에 물려 있지 마라"의 온체인판.
 * 릴의 방법론은 예정을 미리 아는 것이었다. 보유자에게는 그 예정이 호재가 아니라 악재일 때가 많다:
 * 로직 교체·공급 증가·전송 제한이 N일 안에 실행 가능하면 그 종목에 물려 있을 이유가 줄어든다.
 */
export interface AdverseEta { entry: CalendarEntry; hoursUntil: number | null }
export function imminentAdverse(calendar: CalendarEntry[], withinHours: number): AdverseEta[] {
  return calendar
    .filter((c) => c.adverse && (c.status === "executable" || (c.status === "pending" && (c.hoursUntil ?? Infinity) <= withinHours)))
    .map((entry) => ({ entry, hoursUntil: entry.hoursUntil }))
    .sort((a, b) => (a.hoursUntil ?? -Infinity) - (b.hoursUntil ?? -Infinity));
}

/** 임박한 악재 예정 수 → 노출 배수. 지금 실행 가능한 것이 있으면 절반 */
export function etaMultiplier(adverse: AdverseEta[]): number {
  if (adverse.length === 0) return 1;
  const executable = adverse.some((a) => a.entry.status === "executable");
  return executable ? 0.5 : 0.75;
}
