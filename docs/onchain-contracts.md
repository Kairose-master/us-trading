# 컨트랙트 분석 — 크립토의 "공시" (2026-09-03)

## 왜

인스타 릴 하나가 방법론을 정확히 요약했다: 모더나 +177%는 발표 3주 전 공시에 **"하반기에
임상 결과 발표 예정"이라고 문장으로** 적혀 있었고, 스크리닝 툴은 숫자만 긁고 있었다.
*"숫자는 이미 일어난 일이고, 문장은 앞으로 일어날 일"*.

우리 뉴스 데스크가 딱 그 잘못을 하고 있었다 — Google News 헤드라인에서 "surges / jumps /
rally"를 세서 강세 근거로 썼다. 그건 **이미 일어난 급등의 후행 보도**다.

크립토에는 공시가 없다. 대신 **컨트랙트가 있다.** 회사가 문서에 적어 두는 권한과 일정이
여기서는 배포된 바이트코드에 박혀 있고, 누구나 읽을 수 있다. 1차 자료라는 점이 뉴스와 다르다.

그리고 이 방향이 필요한 이유는 측정으로 나왔다: SPA 검정에서 가격 기반 랭킹은
**개별 코인 p=0.947, 우리 규칙 p=0.332, 파라미터 9개 전부 마이너스**였다
(`docs/library-survey.md`). 가격에서 짜낼 것이 없다는 뜻이다.

## 무엇을 읽는가

Etherscan 키가 없어 소스는 못 본다. 대신 **디스패처의 PUSH4 셀렉터**를 읽는다 —
`eth_getCode`로 받은 바이트코드에서 `0x63` + 4바이트 셀렉터 패턴을 찾는다. 평문 검색보다
오탐이 훨씬 적다 (ENA 디스패처에 셀렉터 54개, `63` 접두 확인).

| 심각도 | 셀렉터 | 보유자에게 무엇을 뜻하나 |
|---|---|---|
| high | `mint(address,uint256)` | 발행 진입점 — 공급이 늘 수 있다 |
| high | `pause()` | 전송을 멈출 수 있다 — 팔지 못하게 될 수 있다 |
| high | `upgradeTo(address)` · `upgradeToAndCall` | 지금 읽은 로직이 교체될 수 있다 |
| high | `addBlackList(address)` · `isBlacklisted` | 특정 주소의 전송을 막을 수 있다 |
| medium | `hasRole(bytes32,address)` | 특권이 소유자 한 명이 아니라 역할에 있다 |
| medium | `transferOwnership(address)` | 소유권을 넘길 수 있다 |
| medium | `burnFrom(address,uint256)` | 허용량이 있으면 남의 잔액을 태울 수 있다 |
| info | `paused()` · `implementation()` · `admin()` · `renounceOwnership()` · `burn(uint256)` | 패턴 식별·양성 |

추가로 `owner()`/`getOwner()`, `totalSupply()`, `decimals()`를 호출하고, **EIP-1967 구현
슬롯**을 읽어 프록시면 구현 컨트랙트까지 따라가 같은 스캔을 한다. 판정은
`where: "proxy" | "implementation"`로 어디서 봤는지 남긴다.

## 정직성 — 이 스캔이 말하지 않는 것

- **셀렉터가 있다 = 진입점이 있다.** "소유자가 무한 발행한다"가 아니다. UNI의 mint는 4년 후
  연 2% 상한이 걸려 있다. 판정 문구가 그 차이를 지킨다.
- 표는 **완전하지 않다** — 커스텀 세금·전송 제한·리미터는 표준 셀렉터가 없다.
- `owner`가 EOA인지 멀티시그·타임락인지 **구분하지 않는다**. 그것까지 보면 판정이 달라진다.
- 프록시인데 EIP-1967 슬롯이 비어 있으면 구현을 못 따라가고, 그 사실을 `caveats`에 적는다.
- **자체 체인 코인은 분석 대상이 아니다.** BTC·ETH·SOL·DOGE·ONG은 EVM 컨트랙트가 없다.
  통과가 아니라 "해당 없음"이다.

## 심볼 → 컨트랙트

CoinGecko 무료 API(`/coins/list?include_platform=true` + 시총 상위 1000)를 하루 한 번 부르고
디스크에 캐시한다. 규칙: **이 티커를 쓰는 가장 큰 코인**이 native인지 토큰인지를 정한다.
KRW-BTC는 랩드 BTC가 아니라 비트코인이므로, 동명 랩드 토큰 4개는 명시적으로 쓰지 않는다.
시총 순위 밖이고 컨트랙트를 가진 후보가 둘 이상이면 `ambiguous` — **추측하지 않는다.**

## 실측 (2026-09-03, 이더리움 메인넷)

| 심볼 | 판정 | 근거 |
|---|---|---|
| ANKR | **clean** | 표의 특권 진입점이 디스패처에 없다 |
| SOPH | medium → ×0.75 | `transferOwnership`, `burnFrom` · 살아있는 owner |
| ENA | high | `mint`, `transferOwnership`, `burnFrom` · owner `0xe8dc0fab…` |
| T | high → ×0.5 | `mint`, `transferOwnership`, `burnFrom` |
| FLOCK | high → ×0.5 | `mint`, `hasRole`, `burnFrom` |
| UNI | high | `mint` (연 2% 상한은 코드가 아니라 정책) |
| ONDO | high | `mint`, `hasRole` |
| ARB | high | **EIP-1967 프록시** — `upgradeTo`, `upgradeToAndCall` (코드 2.6KB 껍데기) |
| BTC · ETH · SOL · DOGE · ONG | native | EVM 컨트랙트 없음 — 해당 없음 |

우리 보유 종목 SOPH와 최근 결정에 들어간 FLOCK·T가 전부 걸렸다. 상관·VaR로는 절대 안
나오는 사실이다.

## 어디에 물렸나

- **오피스 리스크 총괄** — 상관·VaR(둘 다 가격) 옆에 컨트랙트 리뷰가 붙는다. high면 비중
  ×0.5, medium이면 ×0.75, 그 결과가 초안의 리비전으로 회의록에 남는다. E2E에서 T·FLOCK이
  절반, SOPH가 ×0.75로 깎여 총노출 45.6% → 41.4%가 됐다.
- **`GET /crypto/contract/:symbol`**, **`GET /crypto/contracts`** (유니버스 전체, 7일 캐시).
- **투자 유니버스 페이지** — 심볼별 배지와 걸린 셀렉터 목록.

## 코드

| 파일 | 무엇 | 순수? |
|---|---|---|
| `backend/src/onchain/selectors.ts` | 셀렉터 표 + EIP-1967 슬롯 상수 | 데이터 |
| `backend/src/onchain/contract-risk.ts` | PUSH4 스캔 · 프록시 해석 · 심각도 판정 | **순수, 테스트 11개** |
| `backend/src/onchain/rpc.ts` | 키 없는 공개 RPC (엔드포인트 페일오버, 초당 5회 토큰버킷) | I/O |
| `backend/src/onchain/registry.ts` | 심볼 → 컨트랙트 (CoinGecko, 24h 캐시) | I/O |
| `backend/src/onchain/contract-desk.ts` | 오케스트레이션 + 7일 디스크 캐시 | I/O |

## 아직 안 한 것

- **언락·베스팅 일정.** 릴의 "일정이 언급된 문장"에 가장 가까운 것이 토큰 언락인데, 베스팅
  컨트랙트 주소를 일반적으로 찾으려면 인덱서가 필요하다. 무료로는 안 된다.
- **타임락 `eta`.** Compound식 Timelock의 `QueueTransaction` 로그는 **정확한 실행 시각이
  박힌 예정 이벤트**다 — 크립토판 "하반기에 발표 예정"에 제일 가깝다. 토큰별 타임락 주소
  레지스트리가 필요하다.
- **우위 측정.** 이건 리스크 필터이지 알파가 아니다. "컨트랙트 clean 종목만 담으면 BTC 보유를
  이기는가"는 SPA로 재야 하고, 아직 안 했다.
