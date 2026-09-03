/**
 * 셀렉터 → 시그니처 표 — 순수 데이터. 4byte 디렉터리 같은 외부 의존 없이,
 * keccak256으로 직접 유도하고 **실물 로그로 교차검증**했다:
 *   ENS 타임락 calldata 0xa9059cbb → transfer(address,uint256)                            ✓
 *   ENS 타임락 calldata 0x6a761202 → Gnosis Safe execTransaction(address,uint256,bytes,…) ✓
 *   ENA 바이트코드 0x40c10f19      → mint(address,uint256)                                 ✓
 *   ARB 프록시    0x3659cfe6       → upgradeTo(address)                                    ✓
 *
 * 목록에 없으면 hex 그대로 남긴다 — 지어내지 않는다. 그래서 `nameOf`는 null을 돌려줄 수 있다.
 * 이 표는 릴이 말한 "숫자가 아니라 문장"을 타임락 캘린더에서 실현하는 부분이다:
 * OZ의 CallScheduled는 calldata만 주므로 이 표가 없으면 `0x973821a6`처럼 보인다.
 */

/** 예정된 호출이 보유자에게 갖는 의미 */
/**
 * "unknown"은 benign이 아니다. 셀렉터가 표에 없으면 효과를 **모른다**는 뜻이고,
 * 모르는 것을 무해하다고 적으면 그게 가짜 데이터다. 그래서 별도 등급으로 둔다:
 * adverse로 취급해 비중을 깎지도 않는다(근거가 없다) — 대신 리포트에 그대로 드러낸다.
 */
export type Impact = "upgrade" | "supply" | "freeze" | "ownership" | "params" | "transfer" | "governance" | "benign" | "unknown";

export interface SignatureSpec { signature: string; impact: Impact }

/** 셀렉터(0x 포함 소문자) → 시그니처. 전부 keccak256으로 유도했다 */
export const SIGNATURES: Record<string, SignatureSpec> = {
  // 업그레이드 — 지금 읽은 로직이 바뀐다
  "0x3659cfe6": { signature: "upgradeTo(address)", impact: "upgrade" },
  "0x4f1ef286": { signature: "upgradeToAndCall(address,bytes)", impact: "upgrade" },
  "0x99a88ec4": { signature: "upgrade(address,address)", impact: "upgrade" },
  "0x9623609d": { signature: "upgradeAndCall(address,address,bytes)", impact: "upgrade" },
  "0x8f283970": { signature: "changeAdmin(address)", impact: "upgrade" },
  "0xd784d426": { signature: "setImplementation(address)", impact: "upgrade" },
  "0xe992a041": { signature: "_setPendingImplementation(address)", impact: "upgrade" },
  "0xc1e80334": { signature: "_acceptImplementation()", impact: "upgrade" },
  "0xc4d66de8": { signature: "initialize(address)", impact: "upgrade" },
  "0x8129fc1c": { signature: "initialize()", impact: "upgrade" },
  // 공급 — 희석
  "0x40c10f19": { signature: "mint(address,uint256)", impact: "supply" },
  "0xa0712d68": { signature: "mint(uint256)", impact: "supply" },
  "0x79cc6790": { signature: "burnFrom(address,uint256)", impact: "supply" },
  "0xfca3b5aa": { signature: "setMinter(address)", impact: "supply" },
  "0x983b2d56": { signature: "addMinter(address)", impact: "supply" },
  "0x3092afd5": { signature: "removeMinter(address)", impact: "supply" },
  // 동결·차단 — 못 팔게 된다
  "0x8456cb59": { signature: "pause()", impact: "freeze" },
  "0x16c38b3c": { signature: "setPaused(bool)", impact: "freeze" },
  "0x0ecb93c0": { signature: "addBlackList(address)", impact: "freeze" },
  "0xe4997dc5": { signature: "removeBlackList(address)", impact: "freeze" },
  "0xf9f92be4": { signature: "blacklist(address)", impact: "freeze" },
  "0x1a895266": { signature: "unBlacklist(address)", impact: "freeze" },
  "0xd01dd6d2": { signature: "setBlacklisted(address,bool)", impact: "freeze" },
  "0x8d1fdf2f": { signature: "freeze(address)", impact: "freeze" },
  "0x45c8b1a6": { signature: "unfreeze(address)", impact: "freeze" },
  "0xf3bdc228": { signature: "destroyBlackFunds(address)", impact: "freeze" },
  "0x8f70ccf7": { signature: "setTrading(bool)", impact: "freeze" },
  "0x8a8c523c": { signature: "enableTrading()", impact: "freeze" },
  "0x7a17feff": { signature: "setTransferLimit(uint256)", impact: "freeze" },
  "0xec28438a": { signature: "setMaxTxAmount(uint256)", impact: "freeze" },
  // 소유권·역할
  "0xf2fde38b": { signature: "transferOwnership(address)", impact: "ownership" },
  "0x715018a6": { signature: "renounceOwnership()", impact: "ownership" },
  "0x13af4035": { signature: "setOwner(address)", impact: "ownership" },
  "0x704b6c02": { signature: "setAdmin(address)", impact: "ownership" },
  "0x8a0dac4a": { signature: "setGuardian(address)", impact: "ownership" },
  "0x2f2ff15d": { signature: "grantRole(bytes32,address)", impact: "ownership" },
  "0xd547741f": { signature: "revokeRole(bytes32,address)", impact: "ownership" },
  "0x36568abe": { signature: "renounceRole(bytes32,address)", impact: "ownership" },
  // 파라미터
  "0x69fe0e2d": { signature: "setFee(uint256)", impact: "params" },
  "0xf46901ed": { signature: "setFeeTo(address)", impact: "params" },
  "0xc6d69a30": { signature: "setTaxRate(uint256)", impact: "params" },
  "0x437823ec": { signature: "excludeFromFee(address)", impact: "params" },
  "0xe01af92c": { signature: "setSwapEnabled(bool)", impact: "params" },
  "0xfca7820b": { signature: "_setReserveFactor(uint256)", impact: "params" },
  "0xe4028eee": { signature: "_setCollateralFactor(address,uint256)", impact: "params" },
  "0xf2b3abbd": { signature: "_setInterestRateModel(address)", impact: "params" },
  "0x55ee1fe1": { signature: "_setPriceOracle(address)", impact: "params" },
  "0xba29482f": { signature: "setMinDelay(uint256)", impact: "governance" },
  "0x64d62353": { signature: "updateDelay(uint256)", impact: "governance" },
  "0xe177246e": { signature: "setDelay(uint256)", impact: "governance" },
  // 자금 이동 — 타임락이 토큰을 옮기는 것은 보통 보조금·베스팅 집행이다
  "0xa9059cbb": { signature: "transfer(address,uint256)", impact: "transfer" },
  "0x23b872dd": { signature: "transferFrom(address,address,uint256)", impact: "transfer" },
  "0x095ea7b3": { signature: "approve(address,uint256)", impact: "transfer" },
  "0x2e1a7d4d": { signature: "withdraw(uint256)", impact: "transfer" },
  "0x205c2878": { signature: "withdrawTo(address,uint256)", impact: "transfer" },
  // 거버넌스 배관
  "0x01d5062a": { signature: "schedule(address,uint256,bytes,bytes32,bytes32,uint256)", impact: "governance" },
  "0x134008d3": { signature: "execute(address,uint256,bytes,bytes32,bytes32)", impact: "governance" },
  "0xc4d252f5": { signature: "cancel(bytes32)", impact: "governance" },
  "0x3a66f901": { signature: "queueTransaction(address,uint256,string,bytes,uint256)", impact: "governance" },
  "0x0825f38f": { signature: "executeTransaction(address,uint256,string,bytes,uint256)", impact: "governance" },
  "0x6a761202": { signature: "execTransaction(address,uint256,bytes,uint8,…) [Gnosis Safe]", impact: "governance" },
  "0xac9650d8": { signature: "multicall(bytes[])", impact: "governance" },
  // 양성
  "0x42966c68": { signature: "burn(uint256)", impact: "benign" },
};

/** 셀렉터 → 시그니처. 모르면 null (hex 그대로 보여줘야 한다) */
export function nameOf(selector: string | null | undefined): SignatureSpec | null {
  if (!selector) return null;
  return SIGNATURES[selector.toLowerCase()] ?? null;
}

/** Compound의 signature 문장에서 impact 추정 — 이벤트가 문장을 직접 주는 경우 */
export function impactOfSignature(signature: string): Impact {
  const s = signature.toLowerCase();
  if (/upgrade|implementation|changeadmin|initialize/.test(s)) return "upgrade";
  if (/mint|minter|burnfrom/.test(s)) return "supply";
  if (/pause|blacklist|blocklist|freeze|trading|transferlimit|maxtx/.test(s)) return "freeze";
  if (/ownership|setowner|setadmin|guardian|role/.test(s)) return "ownership";
  if (/delay|schedule|execute|cancel|multicall/.test(s)) return "governance";
  if (/fee|tax|reservefactor|collateralfactor|interestrate|oracle/.test(s)) return "params";
  if (/transfer|approve|withdraw/.test(s)) return "transfer";
  return "unknown";
}

/** 보유자 입장에서 위험한 예정인가 — 임박했으면 피하고 싶은 종류 */
export const ADVERSE_IMPACTS: Impact[] = ["upgrade", "supply", "freeze"];
export const isAdverse = (i: Impact) => ADVERSE_IMPACTS.includes(i);

/** impact를 한국어로 */
export const IMPACT_KO: Record<Impact, string> = {
  upgrade: "로직 교체",
  supply: "공급 변경",
  freeze: "전송 제한",
  ownership: "권한 이전",
  params: "파라미터",
  transfer: "자금 이동",
  governance: "거버넌스 배관",
  benign: "양성",
  unknown: "효과 미확인",
};
