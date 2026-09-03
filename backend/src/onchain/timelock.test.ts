import { describe, expect, it } from "vitest";
import { ALL_TOPICS, buildCalendar, classifyOwner, decodeCallScheduled, decodeQueueTransaction, decodeScheduled, keysOf, ownerMultiplier, TIMELOCK_TOPICS } from "./timelock.js";

// 아래 두 로그는 **실제 메인넷 로그**를 그대로 붙인 것이다 (ENS TimelockController, Compound식 타임락).
// 디코더를 합성 데이터가 아니라 실물에 고정한다 — 형식을 잘못 이해했으면 여기서 깨진다.
const ENS_SCHEDULED = {"address": "0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7", "topics": ["0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca", "0x29572b227126d89ca7d45a23600f4d5942020bd9f5a6b608b5a180e39f277abe", "0x0000000000000000000000000000000000000000000000000000000000000000"], "data": "0x000000000000000000000000c18360217d8f7ab5e7c516566761ea12ce7f9d72000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a3000000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000009c7db6b1085ec4d07f75c0bd91ad3fcd368fa19e00000000000000000000000000000000000000000000d3c21bcecceda100000000000000000000000000000000000000000000000000000000000000", "blockNumber": "0x1885d11", "transactionHash": "0x1e82eb61c0768c72ac1fc253f8ed0aab03894942c5aadb78673e4785788a62c3"} as Parameters<typeof decodeScheduled>[0];
const COMPOUND_QUEUE = {"address": "0x6d903f6003cca6255d85cca4d3b5e5146dc33925", "topics": ["0x76e2796dc3a81d57b0e8504b647febcbeeb5f4af818e164f11eef8131a6a763f", "0x41b938a70916b32aa4f1841c495ab1e701c1b1da703d544aa860df2b8ef5c628", "0x000000000000000000000000d19d4b5d358258f05d7b411e21a1460d11b0876f"], "data": "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006a83080f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005c49f3ce55a0000000000000000000000001f71901daf98d70b4baf40de080321e5c26768560000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000005400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000000300000000000000000000000074a241aa5e2c0d62ac267fc481790f3474ed5aaf0000000000000000000000004b5dee60531a72c1264319ec6a22678a4d0c81180000000000000000000000004b5dee60531a72c1264319ec6a22678a4d0c811800000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000002b73657456657273696f6e28282875696e7436342c75696e7436342c75696e743634292c737472696e67292900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000236465706c6f79416e6455706772616465546f28616464726573732c6164647265737329000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000236465706c6f79416e6455706772616465546f28616464726573732c6164647265737329000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000970ffd8e335b8fa4cd5c869c7cac3a90671d5dc30000000000000000000000008d38a3d6b3c3b7d96d6536da7eef94a9d7dbc9910000000000000000000000000000000000000000000000000000000000000040000000000000000000000000970ffd8e335b8fa4cd5c869c7cac3a90671d5dc300000000000000000000000060f2058379716a64a7a5d29219397e79bc55219400000000000000000000000000000000000000000000000000000000", "blockNumber": "0x189138b", "transactionHash": "0x9d3e29bfb388001c44804fa4661fcfef4da911f815118fe9c67893eb041276aa"} as Parameters<typeof decodeScheduled>[0];

describe("topics", () => {
  it("are 32-byte hashes and all distinct", () => {
    expect(ALL_TOPICS).toHaveLength(6);
    expect(new Set(ALL_TOPICS).size).toBe(6);
    for (const t of ALL_TOPICS) expect(t).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("decoding real mainnet logs", () => {
  it("reads an OZ CallScheduled: target, value, calldata selector and the delay", () => {
    const c = decodeCallScheduled(ENS_SCHEDULED)!;
    expect(c.family).toBe("oz");
    expect(c.delaySec).toBe(172800); // 정확히 2일
    expect(c.etaSec).toBeNull(); // OZ는 이벤트에 eta가 없다
    expect(c.target).toMatch(/^0x[0-9a-f]{40}$/);
    expect(c.selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(c.calldataBytes).toBeGreaterThan(0);
    expect(c.index).toBe(0);
  });
  it("reads a Compound QueueTransaction: eta comes straight out of the event", () => {
    const c = decodeQueueTransaction(COMPOUND_QUEUE)!;
    expect(c.family).toBe("compound");
    expect(c.etaSec).toBeGreaterThan(1_700_000_000);
    expect(c.delaySec).toBeNull();
    expect(c.target).toMatch(/^0x[0-9a-f]{40}$/);
    expect(c.calldataBytes).toBeGreaterThan(0);
    // signature가 비어 있으면 calldata 셀렉터를 의도로 쓴다
    expect(c.intent.length).toBeGreaterThan(0);
  });
  it("decodeScheduled routes by topic and returns null for anything else", () => {
    expect(decodeScheduled(ENS_SCHEDULED)?.family).toBe("oz");
    expect(decodeScheduled(COMPOUND_QUEUE)?.family).toBe("compound");
    expect(decodeScheduled({ ...ENS_SCHEDULED, topics: ["0x" + "11".repeat(32)] })).toBeNull();
    expect(decodeQueueTransaction(ENS_SCHEDULED)).toBeNull();
    expect(decodeCallScheduled(COMPOUND_QUEUE)).toBeNull();
  });
  it("survives a truncated log without throwing", () => {
    expect(decodeCallScheduled({ ...ENS_SCHEDULED, data: "0x" })).toBeNull();
    expect(decodeQueueTransaction({ ...COMPOUND_QUEUE, data: "0x00" })).toBeNull();
  });
});

describe("calendar", () => {
  const now = 1_800_000_000;
  const call = (key: string, etaSec: number | null) => ({ family: "compound" as const, key, index: null, target: "0xt", valueWei: "0", intent: "setX(uint256)", selector: "0xaaaaaaaa", calldataBytes: 4, etaSec, delaySec: null, blockNumber: 1, txHash: "0xtx" });

  it("classifies pending, executable, expired, executed and cancelled", () => {
    const cal = buildCalendar({
      scheduled: [call("0x1", now + 86_400), call("0x2", now - 3600), call("0x3", now - 30 * 86_400), call("0x4", now + 100), call("0x5", now + 200)],
      executedKeys: new Set(["0x4"]),
      cancelledKeys: new Set(["0x5"]),
      nowSec: now,
    });
    const by = Object.fromEntries(cal.map((e) => [e.key, e.status]));
    expect(by["0x1"]).toBe("pending");
    expect(by["0x2"]).toBe("executable"); // eta 지났지만 유예 안
    expect(by["0x3"]).toBe("expired");
    // 같은 상황이 OZ면 만료가 없다 — 실행되거나 취소될 때까지 계속 실행 가능
    const ozOld = buildCalendar({ scheduled: [{ ...call("0xoz", now - 30 * 86_400), family: "oz" as const }], nowSec: now });
    expect(ozOld[0].status).toBe("executable");
    expect(by["0x4"]).toBe("executed");
    expect(by["0x5"]).toBe("cancelled");
  });
  it("puts live entries first, nearest eta first, and computes hoursUntil", () => {
    const cal = buildCalendar({ scheduled: [call("0x-far", now + 10 * 86_400), call("0x-soon", now + 86_400), call("0x-ready", now - 60)], nowSec: now });
    expect(cal.map((e) => e.key)).toEqual(["0x-ready", "0x-soon", "0x-far"]);
    expect(cal[1].hoursUntil).toBe(24);
    expect(cal[1].etaIso).toBe(new Date((now + 86_400) * 1000).toISOString());
  });
  it("fills an OZ eta from the on-chain getTimestamp result and marks done ones executed", () => {
    const oz = { ...call("0xabc", null), family: "oz" as const, delaySec: 172_800 };
    const filled = buildCalendar({ scheduled: [oz], onchain: { "0xabc": { etaSec: now + 7200, done: false } }, nowSec: now });
    expect(filled[0].status).toBe("pending");
    expect(filled[0].hoursUntil).toBe(2);
    // OZ의 getTimestamp가 1을 주면 그것은 "완료 표시"이지 1970년이 아니다 — eta를 지어내지 않는다
    const done = buildCalendar({ scheduled: [oz], onchain: { "0xabc": { etaSec: null, done: true } }, nowSec: now });
    expect(done[0].status).toBe("executed");
    expect(done[0].etaIso).toBeNull();
  });
  it("says unknown-eta rather than inventing one", () => {
    expect(buildCalendar({ scheduled: [{ ...call("0xz", null), family: "oz" as const }], nowSec: now })[0].status).toBe("unknown-eta");
  });
  it("keysOf picks the indexed key per topic", () => {
    const logs = [
      { address: "0xa", topics: [TIMELOCK_TOPICS.compound.execute, "0xAAA"], data: "0x", blockNumber: "0x1", transactionHash: "0x" },
      { address: "0xa", topics: [TIMELOCK_TOPICS.compound.cancel, "0xBBB"], data: "0x", blockNumber: "0x1", transactionHash: "0x" },
    ];
    expect([...keysOf(logs, TIMELOCK_TOPICS.compound.execute)]).toEqual(["0xaaa"]);
    expect([...keysOf(logs, TIMELOCK_TOPICS.compound.cancel)]).toEqual(["0xbbb"]);
  });
});

describe("owner classification — the thing the bytecode scan could not tell us", () => {
  it("a timelock owner is called out as having an announced delay", () => {
    const r = classifyOwner({ owner: "0xtl", ownerIsZero: false, codeBytes: 11396, timelockEvents: 2, delaySec: 172_800 });
    expect(r.kind).toBe("timelock");
    expect(r.note).toMatch(/2\.0일/);
    expect(ownerMultiplier(r.kind)).toBe(1);
  });
  it("an EOA owner is the worst case — no notice at all", () => {
    const r = classifyOwner({ owner: "0xe0a", ownerIsZero: false, codeBytes: 1, timelockEvents: 0, delaySec: null });
    expect(r.kind).toBe("eoa");
    expect(r.note).toMatch(/예고 없이/);
    expect(ownerMultiplier("eoa")).toBe(0.7);
  });
  it("a contract owner with no timelock events is left undecided, not assumed safe", () => {
    const r = classifyOwner({ owner: "0xc", ownerIsZero: false, codeBytes: 172, timelockEvents: 0, delaySec: null });
    expect(r.kind).toBe("contract");
    expect(r.note).toMatch(/구분하지 못한다/);
    expect(ownerMultiplier("contract")).toBe(0.85);
  });
  it("renounced and absent owners are distinguished", () => {
    expect(classifyOwner({ owner: null, ownerIsZero: true, codeBytes: 0, timelockEvents: 0, delaySec: null }).kind).toBe("renounced");
    expect(classifyOwner({ owner: null, ownerIsZero: false, codeBytes: 0, timelockEvents: 0, delaySec: null }).kind).toBe("none");
    expect(ownerMultiplier("renounced")).toBe(1);
  });
});
