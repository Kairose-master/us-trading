import { EIP1967, ERC20_CORE, SELECTORS, type Severity } from "./selectors.js";

/**
 * 컨트랙트 위험 프로필 — 순수 함수. I/O는 contract-desk.ts가 한다.
 *
 * 가격이 아닌 근거로 "사지 마라"를 말할 수 있게 하는 것이 목적이다. 지금 리스크 총괄은
 * 상관·VaR만 본다(둘 다 가격). 여기서 나오는 것은 1차 자료(배포된 바이트코드)다.
 */

export interface ContractInputs {
  symbol: string;
  chain: string;
  address: string;
  /** eth_getCode 결과 (0x…) */
  codeHex: string;
  /** eth_getStorageAt EIP-1967 구현 슬롯 */
  eip1967Impl?: string | null;
  /** owner() 호출 결과 주소 (없으면 null) */
  owner?: string | null;
  /** totalSupply()·decimals() (없으면 null) */
  totalSupply?: string | null;
  decimals?: number | null;
  /** 프록시면 구현 컨트랙트의 코드도 같이 스캔한다 */
  implCodeHex?: string | null;
}

export interface Finding { sel: string; signature: string; severity: Severity; meaning: string; where: "proxy" | "implementation" }

export interface ContractProfile {
  symbol: string;
  chain: string;
  address: string;
  /** 컨트랙트가 아예 없으면 (EOA·미배포) false */
  deployed: boolean;
  codeBytes: number;
  /** ERC-20 최소 인터페이스가 다 있는가 */
  erc20: boolean;
  proxy: { isProxy: boolean; pattern: "eip1967" | "selector" | "none"; implementation: string | null; implCodeBytes: number | null };
  owner: string | null;
  ownerIsZero: boolean;
  totalSupply: string | null;
  decimals: number | null;
  findings: Finding[];
  /** 최고 심각도 — 리스크 총괄의 판단 입력 */
  severity: Severity | "clean";
  reasons: string[];
  caveats: string[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const norm = (h: string | null | undefined) => (h ?? "").toLowerCase().replace(/^0x/, "");

/** PUSH4(0x63) + 셀렉터 — 디스패처 패턴. 평문 검색보다 오탐이 훨씬 적다 */
export function hasSelector(codeHex: string, sel: string): boolean {
  const c = norm(codeHex);
  return c.includes("63" + sel.toLowerCase());
}

/** 디스패처의 PUSH4 셀렉터 전부 (진단용) */
export function dispatcherSelectors(codeHex: string): string[] {
  return [...new Set((norm(codeHex).match(/63[0-9a-f]{8}/g) ?? []).map((m) => m.slice(2)))];
}

/** 32바이트 슬롯 값 → 주소 (뒤 20바이트). 0이면 null */
export function slotToAddress(slot: string | null | undefined): string | null {
  const h = norm(slot);
  if (!h || /^0+$/.test(h)) return null;
  const a = "0x" + h.slice(-40);
  return a === ZERO ? null : a;
}

export function analyzeContract(p: ContractInputs): ContractProfile {
  const code = norm(p.codeHex);
  const deployed = code.length > 2;
  const codeBytes = Math.floor(code.length / 2);
  const implFromSlot = slotToAddress(p.eip1967Impl);
  const selectorProxy = hasSelector(code, "3659cfe6") || hasSelector(code, "4f1ef286") || hasSelector(code, "5c60da1b");
  const isProxy = Boolean(implFromSlot) || selectorProxy;
  const implCode = norm(p.implCodeHex);

  // 로직은 프록시면 구현에, 아니면 자기 코드에 있다. 둘 다 스캔하되 어디서 찾았는지 남긴다
  const findings: Finding[] = [];
  for (const s of SELECTORS) {
    if (hasSelector(code, s.sel)) findings.push({ ...s, where: "proxy" });
    else if (implCode && hasSelector(implCode, s.sel)) findings.push({ ...s, where: "implementation" });
  }
  const scanTarget = implCode || code;
  const erc20 = ERC20_CORE.every((c) => hasSelector(scanTarget, c.sel));

  const owner = p.owner && p.owner !== ZERO ? p.owner.toLowerCase() : null;
  const ownerIsZero = p.owner === ZERO;

  const worst: Severity | "clean" = findings.some((f) => f.severity === "high")
    ? "high"
    : findings.some((f) => f.severity === "medium")
      ? "medium"
      : findings.length
        ? "info"
        : "clean";

  const reasons: string[] = [];
  if (!deployed) reasons.push("이 주소에 컨트랙트가 없다 (EOA이거나 미배포)");
  if (deployed && !erc20) reasons.push("ERC-20 최소 인터페이스가 다 보이지 않는다 — 표준 토큰이 아니거나 프록시 뒤에 있다");
  if (isProxy) reasons.push(implFromSlot ? `업그레이드 가능 프록시 (EIP-1967, 구현 ${implFromSlot})` : "업그레이드 가능 프록시로 보인다 (셀렉터 기준, 구현 주소 미해석)");
  for (const f of findings.filter((x) => x.severity === "high")) reasons.push(`${f.signature} — ${f.meaning}`);
  for (const f of findings.filter((x) => x.severity === "medium")) reasons.push(`${f.signature} — ${f.meaning}`);
  if (owner) reasons.push(`owner() = ${owner} — 특권 주소가 존재한다 (멀티시그·타임락인지는 이 스캔으로 알 수 없다)`);
  if (ownerIsZero) reasons.push("owner()가 0 — 소유권이 포기됐다");
  if (worst === "clean" && deployed) reasons.push("표에 있는 특권 진입점이 디스패처에 없다");

  const caveats = [
    "셀렉터가 있다 = 진입점이 있다. 실제로 호출 가능한지, 상한이 걸렸는지는 소스·정책이 정한다 (예: UNI의 mint는 연 2% 상한)",
    "이 표는 완전하지 않다 — 커스텀 세금·전송 제한·블랙리스트는 표준 셀렉터가 없다",
    ...(isProxy && !implFromSlot ? ["프록시인데 EIP-1967 슬롯이 비어 있다 — 구현을 못 따라가서 로직 스캔이 불완전하다"] : []),
    ...(owner ? ["owner가 EOA인지 멀티시그·타임락인지 구분하지 않았다 — 그것까지 보면 판정이 달라질 수 있다"] : []),
  ];

  return {
    symbol: p.symbol,
    chain: p.chain,
    address: p.address.toLowerCase(),
    deployed,
    codeBytes,
    erc20,
    proxy: { isProxy, pattern: implFromSlot ? "eip1967" : selectorProxy ? "selector" : "none", implementation: implFromSlot, implCodeBytes: implCode ? Math.floor(implCode.length / 2) : null },
    owner,
    ownerIsZero,
    totalSupply: p.totalSupply ?? null,
    decimals: p.decimals ?? null,
    findings,
    severity: worst,
    reasons,
    caveats,
  };
}

/** 리스크 총괄이 쓰는 한 줄 판정 — 심각도 → 비중 배수 */
export function exposureMultiplier(severity: ContractProfile["severity"]): number {
  return severity === "high" ? 0.5 : severity === "medium" ? 0.75 : 1;
}

export const EIP1967_SLOTS = EIP1967;
