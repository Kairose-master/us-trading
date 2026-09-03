/**
 * 함수 셀렉터 표 — 고정 목록. 순수 데이터.
 *
 * 왜 이게 크립토의 "공시"인가: 회사가 문서에 적어 둔 권한·일정을 크립토에서는 **배포된
 * 바이트코드**가 말한다. Etherscan 키가 없어 소스는 못 봐도, 디스패처의 PUSH4 셀렉터는
 * 누구나 `eth_getCode`로 읽을 수 있다. 1차 자료라는 점이 뉴스 감성과 다르다.
 *
 * 한계를 먼저 적는다:
 *  - 셀렉터가 있다 = **진입점이 있다**. "소유자가 무한 발행할 수 있다"가 아니다.
 *    UNI의 mint는 4년 후 연 2% 상한이 걸려 있다. 판정 문구는 그 차이를 지켜야 한다.
 *  - 이 목록은 완전하지 않다. 커스텀 세금·리미터·블랙리스트는 표준 셀렉터가 없다.
 *  - 프록시면 로직이 구현 컨트랙트에 있다 → 구현 주소를 따라가야 같은 스캔이 의미 있다.
 */

export type Severity = "high" | "medium" | "info";

export interface SelectorSpec {
  /** 4바이트 셀렉터 (0x 없이 소문자 hex 8자) */
  sel: string;
  signature: string;
  severity: Severity;
  /** 보유자에게 무엇을 뜻하는가 */
  meaning: string;
}

/** 표준·널리 쓰이는 셀렉터만. 추측한 것은 넣지 않는다 */
export const SELECTORS: SelectorSpec[] = [
  { sel: "40c10f19", signature: "mint(address,uint256)", severity: "high", meaning: "발행 진입점이 있다 — 공급이 늘 수 있다 (상한 여부는 코드가 아니라 정책이 정한다)" },
  { sel: "8456cb59", signature: "pause()", severity: "high", meaning: "전송을 멈출 수 있는 진입점이 있다 — 팔지 못하게 될 수 있다" },
  { sel: "3659cfe6", signature: "upgradeTo(address)", severity: "high", meaning: "업그레이드 가능 — 지금 읽은 로직이 교체될 수 있다" },
  { sel: "4f1ef286", signature: "upgradeToAndCall(address,bytes)", severity: "high", meaning: "업그레이드 가능 (호출까지) — 로직이 교체될 수 있다" },
  { sel: "e4997dc5", signature: "addBlackList(address)", severity: "high", meaning: "블랙리스트 진입점 — 특정 주소의 전송을 막을 수 있다 (USDT 방식)" },
  { sel: "fe575a87", signature: "isBlacklisted(address)", severity: "high", meaning: "블랙리스트 기능이 있다" },
  { sel: "91d14854", signature: "hasRole(bytes32,address)", severity: "medium", meaning: "역할 기반 권한(AccessControl) — 특권이 소유자 한 명이 아니라 역할에 있다" },
  { sel: "f2fde38b", signature: "transferOwnership(address)", severity: "medium", meaning: "소유권을 넘길 수 있다" },
  { sel: "79cc6790", signature: "burnFrom(address,uint256)", severity: "medium", meaning: "승인 기반 소각 — 허용량이 있으면 남의 잔액을 태울 수 있다" },
  { sel: "5c975abb", signature: "paused()", severity: "info", meaning: "일시정지 상태 조회 — Pausable 패턴" },
  { sel: "5c60da1b", signature: "implementation()", severity: "info", meaning: "프록시 패턴 (구현 주소 조회)" },
  { sel: "f851a440", signature: "admin()", severity: "info", meaning: "프록시 관리자 조회" },
  { sel: "715018a6", signature: "renounceOwnership()", severity: "info", meaning: "소유권 포기 가능 — 권한을 버릴 수 있다" },
  { sel: "42966c68", signature: "burn(uint256)", severity: "info", meaning: "자기 잔액 소각 (양성)" },
];

/** ERC-20 최소 인터페이스 — 이게 없으면 ERC-20이라 부르지 않는다 */
export const ERC20_CORE = [
  { sel: "18160ddd", signature: "totalSupply()" },
  { sel: "a9059cbb", signature: "transfer(address,uint256)" },
  { sel: "095ea7b3", signature: "approve(address,uint256)" },
  { sel: "dd62ed3e", signature: "allowance(address,address)" },
  { sel: "70a08231", signature: "balanceOf(address)" },
];

/** 읽기 전용 호출용 셀렉터 */
export const READ = { totalSupply: "0x18160ddd", decimals: "0x313ce567", owner: "0x8da5cb5b", getOwner: "0x893d20e8", paused: "0x5c975abb", implementation: "0x5c60da1b" } as const;

/** EIP-1967 표준 슬롯 */
export const EIP1967 = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;
