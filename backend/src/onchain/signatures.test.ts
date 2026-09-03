import { describe, expect, it } from "vitest";
import { IMPACT_KO, impactOfSignature, isAdverse, nameOf, SIGNATURES } from "./signatures.js";

describe("signature table", () => {
  it("resolves the selectors we actually saw in real logs and bytecode", () => {
    // ENS 타임락 calldata / ARB 프록시 / ENA 바이트코드에서 실제로 관찰한 셀렉터
    expect(nameOf("0xa9059cbb")?.signature).toBe("transfer(address,uint256)");
    expect(nameOf("0x6a761202")?.signature).toMatch(/execTransaction/);
    expect(nameOf("0x40c10f19")).toEqual({ signature: "mint(address,uint256)", impact: "supply" });
    expect(nameOf("0x3659cfe6")).toEqual({ signature: "upgradeTo(address)", impact: "upgrade" });
  });
  it("returns null for an unknown selector instead of inventing a name", () => {
    expect(nameOf("0x973821a6")).toBeNull(); // ENA 큐에서 실제로 본 미확인 셀렉터
    expect(nameOf(null)).toBeNull();
    expect(nameOf("")).toBeNull();
  });
  it("is case-insensitive on the selector", () => {
    expect(nameOf("0X40C10F19")?.signature).toBe("mint(address,uint256)");
  });
  it("has no duplicate signatures under different selectors and every entry is a 4-byte selector", () => {
    const keys = Object.keys(SIGNATURES);
    for (const k of keys) expect(k).toMatch(/^0x[0-9a-f]{8}$/);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("labels the blacklist family correctly — this was wrong once", () => {
    expect(nameOf("0x0ecb93c0")?.signature).toBe("addBlackList(address)");
    expect(nameOf("0xe4997dc5")?.signature).toBe("removeBlackList(address)");
    expect(nameOf("0xf3bdc228")?.signature).toBe("destroyBlackFunds(address)");
  });
});

describe("impact classification", () => {
  it("reads Compound's signature sentence into an impact class", () => {
    expect(impactOfSignature("_setPendingImplementation(address)")).toBe("upgrade");
    expect(impactOfSignature("mint(address,uint256)")).toBe("supply");
    expect(impactOfSignature("pause()")).toBe("freeze");
    expect(impactOfSignature("transferOwnership(address)")).toBe("ownership");
    expect(impactOfSignature("_setReserveFactor(uint256)")).toBe("params");
    expect(impactOfSignature("transfer(address,uint256)")).toBe("transfer");
    // 모르는 함수는 "양성"이 아니라 "효과 미확인"이다 — 모르는 것을 무해하다고 적지 않는다
    expect(impactOfSignature("somethingUnrecognised(uint256)")).toBe("unknown");
  });
  it("marks upgrade, supply and freeze as adverse for a holder, and nothing else", () => {
    expect(["upgrade", "supply", "freeze"].every(isAdverse as (i: never) => boolean)).toBe(true);
    for (const i of ["ownership", "params", "transfer", "governance", "benign", "unknown"] as const) expect(isAdverse(i)).toBe(false);
    // unknown은 adverse도 benign도 아니다 — 근거 없이 비중을 깎지 않고, 대신 리포트에 드러낸다
    expect(IMPACT_KO.unknown).toBe("효과 미확인");
  });
  it("has a Korean label for every impact class", () => {
    for (const k of Object.keys(IMPACT_KO)) expect(IMPACT_KO[k as keyof typeof IMPACT_KO].length).toBeGreaterThan(1);
    expect(new Set(Object.values(SIGNATURES).map((s) => s.impact)).size).toBeGreaterThan(4);
  });
});
