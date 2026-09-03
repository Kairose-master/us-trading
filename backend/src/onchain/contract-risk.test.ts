import { describe, expect, it } from "vitest";
import { analyzeContract, dispatcherSelectors, exposureMultiplier, hasSelector, slotToAddress } from "./contract-risk.js";
import { ERC20_CORE } from "./selectors.js";

const push4 = (...sels: string[]) => "0x" + sels.map((s) => "63" + s).join("5b");
const erc20 = () => ERC20_CORE.map((c) => c.sel);
const ZERO32 = "0x" + "0".repeat(64);
const base = { symbol: "TEST", chain: "ethereum", address: "0xAbC0000000000000000000000000000000000001" };

describe("selector scanning", () => {
  it("matches only on the PUSH4 dispatcher pattern, not a bare byte sequence", () => {
    expect(hasSelector(push4("40c10f19"), "40c10f19")).toBe(true);
    expect(hasSelector("0xdead40c10f19beef", "40c10f19")).toBe(false); // 앞에 63이 없다
    expect(hasSelector(push4("40c10f19"), "8456cb59")).toBe(false);
  });
  it("lists the dispatcher's selectors without duplicates", () => {
    expect(dispatcherSelectors(push4("40c10f19", "8456cb59", "40c10f19")).sort()).toEqual(["40c10f19", "8456cb59"]);
    expect(dispatcherSelectors("0x")).toEqual([]);
  });
  it("reads an address out of a 32-byte slot and treats zero as absent", () => {
    expect(slotToAddress("0x000000000000000000000000912ce59144191c1204e64559fe8253a0e49e6548")).toBe("0x912ce59144191c1204e64559fe8253a0e49e6548");
    expect(slotToAddress(ZERO32)).toBeNull();
    expect(slotToAddress(null)).toBeNull();
  });
});

describe("contract profile", () => {
  it("an undeployed address is reported as such, not as clean", () => {
    const p = analyzeContract({ ...base, codeHex: "0x" });
    expect(p.deployed).toBe(false);
    expect(p.reasons.some((r) => /컨트랙트가 없다/.test(r))).toBe(true);
  });
  it("a plain ERC-20 with no privileged entrypoints comes back clean", () => {
    const p = analyzeContract({ ...base, codeHex: push4(...erc20()) });
    expect(p.erc20).toBe(true);
    expect(p.severity).toBe("clean");
    expect(p.proxy.isProxy).toBe(false);
    expect(p.findings).toEqual([]);
  });
  it("a mint entrypoint is high severity and is worded as an entrypoint, not as unlimited minting", () => {
    const p = analyzeContract({ ...base, codeHex: push4(...erc20(), "40c10f19") });
    expect(p.severity).toBe("high");
    expect(p.findings[0].signature).toBe("mint(address,uint256)");
    expect(p.findings[0].meaning).toMatch(/진입점/);
    expect(p.caveats.some((c) => /상한/.test(c))).toBe(true);
  });
  it("pause and blacklist are high; role control and ownership transfer are medium", () => {
    expect(analyzeContract({ ...base, codeHex: push4("8456cb59") }).severity).toBe("high");
    expect(analyzeContract({ ...base, codeHex: push4("e4997dc5") }).severity).toBe("high");
    expect(analyzeContract({ ...base, codeHex: push4("91d14854") }).severity).toBe("medium");
    expect(analyzeContract({ ...base, codeHex: push4("f2fde38b") }).severity).toBe("medium");
    expect(analyzeContract({ ...base, codeHex: push4("42966c68") }).severity).toBe("info");
  });
  it("an EIP-1967 proxy is followed to its implementation and findings say where they were seen", () => {
    const p = analyzeContract({
      ...base,
      codeHex: push4("5c60da1b", "3659cfe6"),
      eip1967Impl: "0x000000000000000000000000912ce59144191c1204e64559fe8253a0e49e6548",
      implCodeHex: push4(...erc20(), "40c10f19"),
    });
    expect(p.proxy).toMatchObject({ isProxy: true, pattern: "eip1967", implementation: "0x912ce59144191c1204e64559fe8253a0e49e6548" });
    expect(p.erc20).toBe(true); // 구현 쪽에서 봤다
    expect(p.findings.find((f) => f.signature.startsWith("mint"))?.where).toBe("implementation");
    expect(p.findings.find((f) => f.signature === "upgradeTo(address)")?.where).toBe("proxy");
    expect(p.severity).toBe("high");
  });
  it("a proxy whose implementation slot is empty says the scan is incomplete", () => {
    const p = analyzeContract({ ...base, codeHex: push4("3659cfe6"), eip1967Impl: ZERO32 });
    expect(p.proxy.pattern).toBe("selector");
    expect(p.proxy.implementation).toBeNull();
    expect(p.caveats.some((c) => /구현을 못 따라가서/.test(c))).toBe(true);
  });
  it("distinguishes a live owner from renounced ownership", () => {
    const owned = analyzeContract({ ...base, codeHex: push4(...erc20()), owner: "0xfcb19e6a322b27c06842a71e8c725399f049ae3a" });
    expect(owned.owner).toBe("0xfcb19e6a322b27c06842a71e8c725399f049ae3a");
    expect(owned.reasons.some((r) => /특권 주소가 존재/.test(r))).toBe(true);
    const renounced = analyzeContract({ ...base, codeHex: push4(...erc20()), owner: "0x0000000000000000000000000000000000000000" });
    expect(renounced.owner).toBeNull();
    expect(renounced.ownerIsZero).toBe(true);
    expect(renounced.reasons.some((r) => /포기됐다/.test(r))).toBe(true);
  });
  it("maps severity to an exposure multiplier the risk officer can apply", () => {
    expect(exposureMultiplier("high")).toBe(0.5);
    expect(exposureMultiplier("medium")).toBe(0.75);
    expect(exposureMultiplier("info")).toBe(1);
    expect(exposureMultiplier("clean")).toBe(1);
  });
});
