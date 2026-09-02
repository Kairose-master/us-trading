# 진화 캠페인 — 서로 투자하는 에이전트 개체군 (PyGAD + MCP + Handsel)

릴(vagafx/Algory: "breeds thousands of strategies, makes every one sit an exam on data
it has never seen, only the survivors earn a place in your portfolio")의 구조를 실데이터·
페이퍼 자본으로 옮긴 것. 세 층이 있다.

| 층 | 무엇이 진화하나 | 적합도 | 엔진 |
|---|---|---|---|
| **전략 개체군** (`backend/src/evolution/`) | 로테이션 전략 유전자 10개 (모멘텀 룩백, 변동성 창, P(강세) 하한, 보유 수, 상한, 리밸런스 주기, 변동성 목표, 최대 노출, 동료 위탁 비율·수) | **본 적 없는 60일**(Upbit 실캔들, HMM은 훈련 구간만 적합) Sharpe − 2·MDD | **PyGAD** (`backend/evolution/pygad_step.py`, 토너먼트·균등 교차·범위 내 변이). 파이썬 없으면 내장 연산자, 결과에 engine 표기 |
| **Handsel 오피스 에이전트** | 실제 Handsel 에이전트(차트·뉴스·…·위원장) | 독립 채점 통과율 + 실제 정산 USDC | Handsel **lineage mandate** (복제·은퇴) + **Automaton** (본드 자동 충전). 테스트넷 오피스 1에 둘 다 ON |
| **연결** | 개체가 쓰는 데이터·Handsel 조작 | — | **MCP** (워커 툴, Handsel MCP) |

## 개체 생애

- **창세**: 12개 무작위 유전자, 각 ₩1,000,000 페이퍼 시드.
- **시험**: 매 세대 전원이 같은 시험지(최근 60일)를 본다. 훈련 구간 성과는 보지 않는다.
- **서로 투자**: 유전자 `peerAlloc`만큼 자본을 적합도 상위 `peerTopN` 동료에게 위탁한다.
  그날 수익 = (1−peerAlloc)·자기 수익 + peerAlloc·동료 평균 수익. 자본이 잘하는 개체로
  흐른다.
- **자본 마킹**: 새 일봉이 생길 때만, 각자의 실제 타깃 비중으로 t→t+1 실현 수익을 반영.
- **죽음**: 자본 < 시드 60%(굶주림) 또는 3세대 연속 하위 20%(도태, 최소 나이 3세대).
  자본은 금고로. 기록은 남는다.
- **출생**: 생존자 상위를 부모로 PyGAD 자식 생성. 유전 거리가 가장 가까운 상위 개체가
  **자기 자본의 30%를 실제로 떼어** 시드로 준다. 여유가 없으면 못 낳는다. 인구 상한 24.
- **스쿼드 배치**: 상위 3 생존자의 최신 타깃을 적합도 가중 평균 → `DEPLOY`로 페이퍼 장부에
  회전(rotateTo). 실주문 모드면 거부.

## 원형(archetype)

유전자에서 읽히는 군집 라벨 — REGIME_GATED · MOMENTUM_SPRINTER · TREND_RIDER ·
CONCENTRATOR · DIVERSIFIER · FUND_OF_AGENTS · LOW_VOL · BALANCED. 릴의 MULTI_SIGNAL /
BREAKOUT_HUNTER 군집처럼 `/evolution`의 개체군 구름에서 군집으로 그려진다.

## API

`GET /api/evolution` (상태·스쿼드·세대 이력) · `GET /api/evolution/agents` · `/agents/:id` ·
`/log` · `/lineage`(Handsel lineage_report + Automaton 상태) ·
`POST /api/evolution/step` · `POST /api/evolution/deploy` (둘 다 owner 세션).
WS `evolution`(세대 기록), `evolution:log`.

## 검증 (2026-09-02, 로컬 실캔들 27마켓)

3세대: 창세 12 → 15 → 18 → 22 생존, 출생 3/3/4 (전부 `pygad@3.7.0`
tournament/uniform/random), 챔피언 JUNO-01 [DIVERSIFIER] fitness 4.16 (시험 60일).
죽음은 0 — 시드 대비 60% 굶주림·3세대 하위 도태 조건이 며칠 자본 마킹 뒤에야 걸린다.

## 정직성 규칙

- 시험지는 항상 훈련 구간 밖. HMM 파라미터는 훈련 구간에서 고정.
- 자본은 실캔들 수익으로만 움직인다. 세대 안에서 같은 날을 두 번 세지 않는다.
- PyGAD가 실제로 돌았는지 `engine` 필드가 말한다. 내장 대체는 이름을 바꾸지 않는다.
- 전부 페이퍼. 실돈 경계는 `CRYPTO_TRADE_ALLOW_REAL`이 그대로 지킨다.
