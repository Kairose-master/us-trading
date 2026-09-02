# 통합 제어 평면 (Control Plane)

대시보드 홈(`/`)의 **Command Center**가 보여주는 것. 이전에는 알트 스캐너·증권
오피스·진화 스쿼드·파이프라인 신호가 **각자** 페이퍼 장부를 회전시켰다. 네 개가
따로 놀면 마지막에 실행된 엔진이 앞 엔진의 결정을 그냥 덮어썼고, 어느 엔진이
돈을 벌었는지 알 길이 없었다. 이제 엔진은 장부를 건드리지 못한다.

```
소스(Upbit·Yahoo·RSS) → 파이프라인(HMM 국면·GARCH·신호 DAG)
   → 엔진 4개 ── 제안(proposal) ──▶ 중재기(arbiter) ──▶ 승인/오토파일럿 ──▶ 페이퍼 장부
```

코드: `backend/src/control/plane.ts` (단일 `controlPlane`), 상태 파일
`data/control/state.json`, 화면 `frontend/components/dashboard/command-center.tsx`.

## 제안 (proposal)

각 엔진은 `controlPlane.propose({ engine, targets, confidence, evidence, ref })`
한 가지만 호출한다. `targets`는 `{ market, weightPct }[]`, `confidence`는 0~1.

| 엔진 | 언제 | 확신도 |
|---|---|---|
| `scanner` 알트 스캐너 | 24h 로테이션 / `POST /crypto/scanner/rotate` | 강세 종목 수 ÷ 스캔 종목 수 |
| `office` 증권 오피스 | Handsel 오피스 런이 채점을 통과해 결정 JSON을 냈을 때 | 통과 단계 ÷ 전체 단계 |
| `evolution` 진화 스쿼드 | 세대마다 (`EVOLUTION_PROPOSE=true`) 또는 `POST /evolution/deploy` | 0.25 + 평균 적합도 ÷ 4 |
| `signals` 파이프라인 신호 | 15분마다 크립토 파이프라인 스냅샷 | 앙상블 알파의 평균 신뢰도 |

엔진당 살아있는 제안은 **하나**(새 제안이 이전 것을 대체), 유효기간
`proposalTtlH`(기본 30h). 만료된 제안은 중재에서 빠진다.

## 중재 (arbiter)

살아있는 제안을 켜진 엔진끼리 섞는다.

1. 엔진 기여도 = `weight × (0.25 + 0.75 × confidence)`, 합이 1이 되게 정규화.
2. 종목 비중 = Σ 기여도 × 그 엔진의 목표 비중.
3. 제약(policy) 적용, 발동한 것은 결정의 `constraints`에 그대로 적힌다:
   `maxWeightPct`(종목당 상한) · `maxPositions`(상위 N만) · `grossMaxPct`(총노출)
   · `cashFloorPct`(현금 하한).
4. 회전율 = 현재 보유 비중 대비 절대 변화 ÷ 2. `minTurnoverPct` 미만이면
   **skipped**(거래할 가치가 없음).
5. 킬스위치가 켜져 있으면 **blocked**.
6. 마지막 집행 후 `minIntervalMin`이 안 지났으면 **pending**으로 붙잡아 둔다.
7. 오토파일럿이면 즉시 집행, 아니면 **pending** — 운영자가 승인/거부한다.

결정(`Decision`)에는 기여한 엔진과 가중치, 근거 줄(`rationale`), 발동한 제약,
회전율, 집행 결과(주문 수·건너뛴 종목·오류)가 남는다. 최근 200건을 보관한다.

## 집행 — 돈 경계는 그대로

집행은 `cryptoDesk.rotateTo()` 하나뿐이고 이것은 **페이퍼 전용**이다.
`CRYPTO_TRADE_ALLOW_REAL`이 켜진 실주문 모드에서는 rotateTo가 거부하므로 제어
평면이 실제 돈을 움직일 길이 없다. 데스크가 추적하지 않는 알트의 현재가는 집행
직전에 Upbit 티커로 채우고, 그래도 없는 종목은 건너뛰고 `skipped`에 남긴다.

## 귀속 (attribution) — 엔진 가중치가 스스로 움직인다

매시간 `markControl`이 날짜가 바뀌었는지 보고, 바뀌었으면 각 엔진의 **마지막
제안 포트폴리오**가 그날 실제로 낸 수익률을 일봉으로 계산한다
(`getDayCandles`). 가중치는 지수가중 규칙 `w ← w × exp(η × r)` 으로 갱신되고
(η 기본 8, `quant/allocator`와 같은 규칙) 평균 1로 정규화된다. 화면의 "누적"은
그 엔진 제안을 그대로 따랐을 때의 누적 수익이다 — 집행 여부와 무관하게, 제안
자체의 성적이다.

## 사람 없이 돌아가기 — 그리고 한 손으로 멈추기

기본 상태는 **무인 운행**이다. 집행 간격 60분·최소 회전 8%가 기본이라 15분마다 오는
신호 제안까지 전부 잔거래로 집행되지는 않는다 (2026-09-02 장부가 그렇게 오염돼
₩10,000,000에서 초기화했다). 무엇이 자동인지:

| 무엇 | 어떻게 |
|---|---|
| 제안 | 스캐너 24h, 오피스(로컬) `OFFICE_INTERVAL_H`, 진화 `EVOLUTION_INTERVAL_H`, 파이프라인 신호 15분 — 전부 기본 ON |
| 중재·집행 | 제안이 오면 즉시 중재, 오토파일럿이면 즉시 페이퍼 집행 |
| 보류 결정 | 집행 간격(`minIntervalMin`) 때문에 보류된 결정은 `CONTROL_TICK_MIN`(기본 5분) 스케줄러가 간격이 지나면 **현재 제안들로 다시 중재해 집행**한다. 사람이 승인 버튼을 누를 필요가 없다 |
| 엔진 가중치 | 매일 각 엔진의 마지막 제안이 낸 실현 수익으로 지수가중 갱신 (η=8). 손대지 않는다 |
| 만료 | TTL 지난 제안과 보류 결정은 스케줄러가 치운다 |
| 부팅 | 오토파일럿은 **매 부팅마다 `CONTROL_AUTOPILOT`(기본 true)로 돌아간다.** 화면의 승인제 토글은 그 부팅 동안만이다 — 재배포하면 다시 자동 |

멈추는 손은 하나다: **`POST /control/pause`** (홈의 "자동 운행 정지"). 상태 파일에
남아 재부팅·재배포에도 유지되고, 켜져 있는 동안 모든 결정은 `blocked`로 기록된다.
`POST /control/resume`("자동 운행 재개")이 풀고 곧바로 보류 결정을 다시 중재한다.
킬 스위치(리스크)는 별개로 여전히 집행을 막는다.

상태(`GET /control`)의 `unattended`가 true면 오토파일럿 ON·정지 아님·킬스위치 아님,
즉 지금 사람 없이 집행되는 상태다.

## API

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/api/control` | 토큰 | 전체 상태 (엔진·제안·대기 결정·결정 로그·보유·정책) |
| POST | `/api/control/autopilot` `{on}` | 세션 | 오토파일럿 켜기/끄기 (이번 부팅 동안). 켜면 대기 결정을 바로 재중재 |
| POST | `/api/control/pause` | 세션 | 지속 정지 — 재배포에도 유지, 모든 집행 차단 |
| POST | `/api/control/resume` | 세션 | 정지 해제 + 즉시 재중재 |
| POST | `/api/crypto/paper/reset` `{startKrw?}` | 운영자 토큰 (프록시 없음) | 페이퍼 장부 초기화 — 포지션·주문·에쿼티 기록 삭제, 시드(기본 ₩10,000,000)에서 재시작. 제어 평면은 보류 결정·집행 시각을 비우고 정책을 기본값으로 돌린다. 결정 로그·엔진 귀속은 남는다 |
| POST | `/api/control/approve` | 세션 | 대기 결정 집행 (페이퍼) |
| POST | `/api/control/reject` | 세션 | 대기 결정 거부 |
| POST | `/api/control/engines/:id` `{enabled?, weight?}` | 세션 | 엔진 on/off, 가중 0.05~5 |
| POST | `/api/control/policy` | 세션 | 제약 수정 |
| POST | `/api/control/arbitrate` | 세션 | 지금 중재 |

WebSocket `control`(상태 전체), `control:decision`(결정 하나).

환경: `CONTROL_AUTOPILOT`(기본 true — 매 부팅의 기본값), `CONTROL_TICK_MIN`(기본 5),
`EVOLUTION_PROPOSE`(기본 true), `CRYPTO_SCANNER`·`OFFICE_LOOP`·`EVOLUTION`(전부 기본 true).

## 검증 (2026-09-02, 로컬)

부팅 직후 `signals` 엔진이 첫 제안 → 오토파일럿 집행 2건. 오토파일럿을 끄고
`POST /crypto/scanner/rotate` → 5종목 제안 → "last execution 0m ago < 30m —
held as pending" → `POST /control/approve` → 운영자 집행. 첫 실행에서 스캐너
유니버스의 알트 5종이 전부 "현재가 없음"으로 건너뛰어졌다 — 제어 평면이 데스크
관찰 종목의 가격만 알고 있었기 때문. 집행 직전 Upbit 티커로 빠진 가격을 채우는
`pricesFor`가 그 수정이다.
