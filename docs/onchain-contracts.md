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

## 타임락 `eta` 캘린더 (2026-09-03)

릴의 "회사가 하반기에 발표 예정이라고 **문장으로** 써놨다"에 가장 가까운 크립토 자료가 이것이다.
거버넌스 타임락은 실행할 트랜잭션을 **미래 시각(eta)과 함께 큐에 넣고 이벤트로 공표한다.**
가격이 아니라 **예정**이고, 온체인 1차 자료다.

### 두 가문

| 가문 | 이벤트 | eta를 어디서 얻나 |
|---|---|---|
| Compound | `QueueTransaction(bytes32 indexed txHash, address indexed target, uint value, string signature, bytes data, uint eta)` | 이벤트에 직접 있다. **`signature`가 사람이 읽는 문장**이다 (`_setPendingImplementation(address)`). 비면 calldata 셀렉터를 쓴다 |
| OpenZeppelin | `CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)` | 이벤트엔 `delay`만 있다 → `getTimestamp(id)`가 eta를 직접 주고 완료 여부까지 알려준다 (0 미등록 · **1은 완료 표시이지 1970년이 아니다** · 그 외 eta) |

topic0는 keccak256으로 유도하고 **실물 로그로 검증**했다: ENS TimelockController의 `CallScheduled`
2건(지연 172800초 = 정확히 2.0일), Compound식 타임락의 `QueueTransaction` 46건. 테스트는 그 실제
로그를 그대로 붙여 디코더를 고정한다 — 형식을 잘못 이해했으면 테스트에서 깨진다.

만료 규칙도 가문마다 다르고, 뭉개지 않는다: **OZ는 만료가 없다**(실행·취소될 때까지 계속
실행 가능), Compound식은 `GRACE_PERIOD`(기본 14일)를 지나면 죽는다.

### 레지스트리를 손으로 관리하지 않는다

타임락 주소 목록을 유지보수하는 대신 **찾아낸다**: 토큰의 `owner()`(그리고 프록시 관리자)가
후보이고, 그 주소에서 타임락 이벤트가 실제로 나오는지 + `getMinDelay()`/`delay()`가 답하는지로
판별한다. 안 나오면 "타임락 아님"이라고 적을 뿐 추측하지 않는다.

### owner 종류 — 바이트코드 스캔이 못 하던 판별

컨트랙트 프로필은 원래 *"멀티시그·타임락인지는 이 스캔으로 알 수 없다"*고 적어 뒀다. 이제 안다.

| 종류 | 뜻 | 노출 배수 |
|---|---|---|
| `timelock` | 특권 행사에 **공표된 지연**이 붙는다 | ×1 (벌점 없음) |
| `contract` | 컨트랙트지만 타임락 이벤트가 없다 — 멀티시그인지 커스텀인지 구분 못 함 | ×0.85 |
| `eoa` | 코드가 없다 = 개인키. **예고 없이 즉시** 특권을 쓸 수 있다 | ×0.7 |
| `renounced` · `none` | 소유권 포기 · owner() 없음 | ×1 |

최종 배수 = 컨트랙트 심각도 배수 × owner 배수. 리스크 총괄이 그걸 비중에 곱한다.

### 실측 (2026-09-03)

```
ENS   owner = OZ 타임락, 지연 2.0일, 28일간 예약 2건 (둘 다 executed)
ENA   owner = OZ 타임락, 지연 1.0일, 28일간 예약 39건 · 살아있는 것 31건
T     high(mint)이지만 owner가 OZ 타임락(지연 2.0일) → ×0.5   (owner 벌점 없음)
SOPH  medium × owner가 171B 미확인 컨트랙트(×0.85)      → ×0.637 (복합 감점)
ANKR  clean · owner() 없음
FLOCK high(mint) · owner() 없음                          → ×0.5
BTC·ETH·XRP·SOL  native — 해당 없음
```

**같은 `mint` 진입점이 T에서는 덜 위험하고 SOPH에서는 더 위험하다** — T는 2일 예고가 붙고
SOPH의 owner는 정체를 모르기 때문이다. 가격으로는 절대 나오지 않는 구분이다.

### 어디에 물렸나

- 오피스 리스크 총괄의 컨트랙트 리뷰 줄에 owner 종류·지연·**큐에 든 실행의 eta**가 붙는다.
- `GET /crypto/timelock/:symbol`, 그리고 `GET /crypto/contracts`의 각 항목에 `timelock` 필드.
- 투자 유니버스 페이지: 심볼 배지에 ⏳지연·EOA·큐 건수, 그리고 살아있는 eta 목록.

### 코드

| 파일 | 무엇 | 순수? |
|---|---|---|
| `backend/src/onchain/timelock.ts` | topic·셀렉터 상수, 두 가문 디코더, 캘린더 조립, owner 분류 | **순수, 테스트 14개 (실물 로그로 고정)** |
| `backend/src/onchain/timelock-desk.ts` | 타임락 발견 · 로그 조회 · `getTimestamp`/`queuedTransactions`로 상태 확인 | I/O |
| `backend/src/onchain/rpc.ts` | `getLogs` 추가 — 엔드포인트마다 범위 제한이 달라 20만→10만→1만으로 줄여가며 시도 | I/O |

`eth_getLogs` 공개 엔드포인트 실측: publicnode는 archive 조회 자체를 거부(유료 토큰 요구),
flashbots 10만 블록, drpc 무료 1만, blastapi **10 블록**, tenderly public **20만 OK** →
로그는 tenderly부터 시도한다.

### 예정을 문장으로 — 셀렉터 표 (2026-09-03)

OZ의 `CallScheduled`는 calldata만 준다. 표가 없으면 캘린더가 `0x973821a6`처럼 보이는데,
릴의 요지가 **"숫자가 아니라 문장"**이었으므로 그건 절반만 한 것이다. 그래서
`backend/src/onchain/signatures.ts`에 셀렉터 → 시그니처 표를 뒀다. 4byte 디렉터리 같은
외부 의존 없이 **keccak256으로 직접 유도하고 실물로 교차검증**했다:

```
ENS 타임락 calldata 0xa9059cbb → transfer(address,uint256)                            ✓
ENS 타임락 calldata 0x6a761202 → execTransaction(address,uint256,bytes,uint8,…) Safe   ✓
ENA 바이트코드    0x40c10f19  → mint(address,uint256)                                  ✓
ARB 프록시        0x3659cfe6  → upgradeTo(address)                                     ✓
```

같은 작업에서 **기존 표의 오류를 잡았다**: `e4997dc5`를 `addBlackList`로 적어 뒀는데
실제로는 `removeBlackList`이고 `addBlackList`는 `0ecb93c0`이다. 둘 다 블랙리스트 기구가
있다는 뜻이라 심각도는 같지만, 리스크 리포트에 틀린 함수명이 실리면 안 된다.

각 예정은 보유자 입장의 **impact**로 분류된다:

| impact | 뜻 | 불리한가 |
|---|---|---|
| 로직 교체 (upgrade) | 지금 읽은 코드가 바뀐다 | **예** |
| 공급 변경 (supply) | 희석 | **예** |
| 전송 제한 (freeze) | 못 팔게 된다 | **예** |
| 권한 이전 · 파라미터 · 자금 이동 · 거버넌스 배관 · 양성 | — | 아니오 |
| **효과 미확인 (unknown)** | 셀렉터가 표에 없다 | **판단 안 함** |

`unknown`이 `benign`과 별도인 것이 중요하다. 첫 구현은 모르는 셀렉터를 "양성"으로
기본 분류했는데, **모르는 것을 무해하다고 적으면 그게 가짜 데이터다.** 지금은 "효과 미확인"으로
표시하고, 근거가 없으니 비중도 깎지 않는다 — 대신 리포트와 화면에 그대로 드러낸다.
실측이 그 필요를 보여준다: ENA의 큐 39건 중 **37건이 미확인 셀렉터**(`0x973821a6`)이고 2건만
함수명으로 읽힌다. ENS는 2/2 전부 읽힌다.

### 임박한 악재 예정 — "카탈리스트에 물려 있지 마라"

`imminentAdverse(calendar, withinHours)`는 **지금 실행 가능하거나 N시간(기본 14일) 안에
실행될 수 있는** 불리한 예정을 고른다. 노출 배수는 지금 실행 가능하면 ×0.5, 임박했으면 ×0.75.

리스크 총괄의 최종 배수는 세 갈래의 곱이다:

```
컨트랙트 심각도(무엇을 할 수 있나) × owner 종류(예고가 붙나) × 임박한 악재 예정(언제 일어나나)
```

마지막 항이 릴의 방법론에 해당한다 — 일정이 이미 공표됐으면 그 안에 물려 있지 않는다.

### 아직 안 한 것

- **언락·베스팅 일정.** 베스팅 컨트랙트 주소를 일반적으로 찾으려면 인덱서가 필요하다.
- **미확인 셀렉터.** ENA의 `0x973821a6`처럼 프로젝트 고유 함수는 표에 없다. 4byte 디렉터리를
  붙이면 커버리지가 오르지만 외부 의존이 하나 늘고, 그 디렉터리도 크라우드소스라 틀릴 수 있다.
  지금은 "미확인"으로 두는 쪽을 택했다.
- **우위 측정.** 이건 리스크 필터이지 알파가 아니다. "eta가 임박한 종목을 피하면 BTC 보유를
  이기는가"는 SPA로 재야 하고, 아직 안 했다. 게다가 컨트랙트 프로필은 **현재 스냅샷**이라
  과거로 되돌릴 수 없다 — 오늘의 분류를 과거에 적용하면 룩어헤드다. 정직한 측정 방법부터 설계해야 한다.

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
