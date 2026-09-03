# 진화 캠페인 — 서로 투자하는 에이전트 개체군 (PyGAD + MCP + Handsel)

릴(vagafx/Algory: "breeds thousands of strategies, makes every one sit an exam on data
it has never seen, only the survivors earn a place in your portfolio")의 구조를 실데이터·
페이퍼 자본으로 옮긴 것. 세 층이 있다.

| 층 | 무엇이 진화하나 | 적합도 | 엔진 |
|---|---|---|---|
| **전략 개체군** (`backend/src/evolution/`) | 로테이션 전략 유전자 10개 (모멘텀 룩백, 변동성 창, P(강세) 하한, 보유 수, 상한, 리밸런스 주기, 변동성 목표, 최대 노출, 동료 위탁 비율·수) | **본 적 없는 60일**(Upbit 실캔들, HMM은 훈련 구간만 적합) Sharpe − 2·MDD | **PyGAD** (`backend/evolution/pygad_step.py`: 출생 = 토너먼트·균등 교차·변이, 자발 변이 = `random_mutation`). **병합·분기**는 PyGAD에 없는 개체군 연산이라 `population.ts`가 직접 한다. 파이썬 없으면 내장 연산자, 결과에 engine 표기 |
| **Handsel 오피스 에이전트** | 실제 Handsel 에이전트(차트·뉴스·…·위원장) | 독립 채점 통과율 + 실제 정산 USDC | Handsel **lineage mandate** (복제·은퇴) + **Automaton** (본드 자동 충전). 테스트넷 오피스 1에 둘 다 ON |
| **연결** | 개체가 쓰는 데이터·Handsel 조작 | — | **MCP** (워커 툴, Handsel MCP) |

## 개체 생애

- **창세**: 12개 무작위 유전자, 각 ₩1,000,000 페이퍼 시드.
- **시험**: 매 세대 전원이 같은 시험지를 보되, 시험지는 **세대마다 다른 60일 창**이다(아래 절). 훈련 구간 성과는 보지 않는다.
- **서로 투자**: 유전자 `peerAlloc`만큼 자본을 적합도 상위 `peerTopN` 동료에게 위탁한다.
  그날 수익 = (1−peerAlloc)·자기 수익 + peerAlloc·동료 평균 수익. 자본이 잘하는 개체로
  흐른다.
- **자본 마킹**: 새 일봉이 생길 때만, 각자의 실제 타깃 비중으로 t→t+1 실현 수익을 반영.
- **죽음**: 자본 < 시드 60%(굶주림) 또는 3세대 연속 하위 20%(도태, 최소 나이 3세대).
  자본은 금고로. 기록은 남는다.
- **출생**: 생존자 상위를 부모로 PyGAD 자식 생성. 유전 거리가 가장 가까운 상위 개체가
  **자기 자본의 30%를 실제로 떼어** 시드로 준다. 여유가 없으면 못 낳는다. 인구 상한 24.
- **변이**: 살아 있는 개체가 세대마다 확률 10%로 유전자 1~2개를 바꾼다 (PyGAD
  `random_mutation`, gene_space 안 치환). 개체군 다양성(생존 개체 간 평균 유전 거리)이
  0.18 아래로 떨어지면 변이율이 최대 +25%p 올라간다 — 수렴을 막는 적응 변이.
- **병합**: (a) 유전 거리 < 0.06인 두 개체는 사실상 같은 전략이라 하나로 합친다 — 자본
  합산, 유전자는 자본가중 혼합, 흡수된 쪽은 `merged into X`로 은퇴. (b) 동료에게 자본
  25% 이상을 위탁하면서 그 동료보다 fitness가 1.0 이상 낮은 개체는 그 동료에 흡수된다.
  세대당 최대 2건.
- **분기**: 상위 20% 중 아직 분기하지 않은 개체(나이 ≥ 2세대, 자본 ≥ 시드 80%)가 두
  가지로 갈라진다 — 자본 반씩, 무작위 유전자 하나를 서로 반대 방향으로 25% 밀어 서로
  다른 탐색 계통(tribe `X/A`, `X/B`)을 만든다. 부모는 `forked into A / B`로 소멸. 세대당 1건.
- **계통(tribe)**: 창세 개체 id 또는 분기 가지 id. 출생 자식은 부모의 계통을 잇는다.
  개체 패널에 생애 사건(born · mutated · merged · absorbed · forked · retired)이 남는다.
- **스쿼드 배치**: 상위 3 생존자의 최신 타깃을 적합도 가중 평균 → `DEPLOY`로 페이퍼 장부에
  회전(rotateTo). 실주문 모드면 거부.

## 에이전트 = 오피스: 데스크(실 MCP 도구)와 스킬

개체는 숫자 전략만 돌리지 않는다. 유전자 17개 중 뒤의 7개가 **오피스 유전자**다:
`deskChart·deskNews·deskFlow·deskMacro·deskRisk·deskWeb`(0/1)과 `toolTrust`(0~1).
데스크 하나는 실제 MCP 서버의 툴 하나다 — 우리 Vercel 워커의
`upbit_market_report / upbit_news_report / upbit_flow_report / macro_report /
basket_risk_report`와 Exa의 `web_search_exa`. 호출은 진짜고 세대마다 **임대료**가
자본에서 빠진다(데스크당 자본의 0.10~0.25%, 합쳐서 최대 1.15%/세대). 눈이 없는
개체는 공짜, 눈이 많은 개체는 비싸다. 도구값을 못 하면 굶어 죽는다.

**스킬**은 보고서를 타깃에 반영하는 결정적 규칙이다 (`capabilities.ts`, 전부 순수 함수,
파싱 실패는 "적용 안 함"):

| 데스크 | 읽는 것 | 스킬 |
|---|---|---|
| 차트 | MA20 위/아래, HMM 국면 라벨(강세/약세/고변동) | MA20 아래거나 `약세` 라벨이면 종목 제외 |
| 뉴스 | 실제 Google News 헤드라인의 렉시콘 감성 | aggregate BEARISH 종목 거부, 그 외 감성만큼 비중 기울기 |
| 수급 | 호가 불균형, 테이커 매수 비중 | 비중 기울기 (±40% × 신뢰도) |
| 매크로 | VIX·S&P·달러로 risk-on/off | risk-off면 노출 ×(1−0.5·신뢰도), mixed면 ×(1−0.2·신뢰도) |
| 리스크 | 60일 상관행렬의 평균 쌍상관 | >0.75(한 베팅)면 노출 ×(1−0.4·신뢰도) |
| 웹 검색 | Exa 결과 제목을 우리 렉시콘으로 채점 | 뉴스 데스크의 2차 의견 (절반 강도) |
| 위원회 | Handsel 오피스의 채점 통과 결정 JSON | 신뢰도만큼 위원장 타깃 쪽으로 혼합 (차트+리스크 데스크를 켜고 신뢰도≥0.5인 개체만, 임대료 0.3%) |

기울기는 총노출을 **늘리지 못한다** — 상한은 언제나 순수 전략의 노출이다. 스킬은
종목을 빼거나, 비중을 옮기거나, 노출을 줄일 수만 있다.

**시험은 그대로 순수 전략의 성적**(보고서는 오늘 것이라 60일 전으로 되돌릴 수
없다)이고, **자본 마킹은 스킬을 거친 타깃**으로 된다. 그래서 적합도(fitness)와
생존(자본)이 갈린다: 시험을 잘 봐도 데스크를 잘못 읽으면 자본이 줄고, 데스크를
잘 읽으면 시험 점수와 무관하게 자본이 는다. 도구를 쓰는 능력이 유전된다.

같은 세대의 같은 질의는 한 번만 부른다(공유 캐시). 개체 24개가 뉴스 데스크를 켜도
호출은 1회, 임대료는 24번 — 오피스가 데스크를 나눠 쓰는 것과 같다.

원형에 `FULL_OFFICE`(데스크 4개+, 신뢰도≥0.5)와 `TOOL_USER`(2개+, ≥0.4)가 추가됐다.
구버전 10유전자 개체는 데스크 전부 0(눈 없음), 신뢰도 0.5로 확장된다 — 도구는
진화가 스스로 켜야 한다.

### 검증 (2026-09-02, 로컬, 실 MCP 호출)

GEN 1: 생존 15 중 11이 데스크를 빌렸다. 뉴스 데스크가 BTC·SOL을 BEARISH(-0.307,
-0.224, 각 8개 헤드라인)로 거부, 수급 데스크가 SOL 호가 불균형 +80%/테이커 매수
67%로 기울기, 리스크 데스크가 평균 쌍상관 0.80으로 노출 ×0.83, 매크로는 mixed.
첫 실행에서 차트 스킬이 MA20 위 종목까지 잘랐다 — 워커의 3상태 HMM은 중립
국면에서 P(bull)=0을 내므로 `P(bear)>P(bull)`만으로는 안 된다. 지금은 MA20 아래
이거나 **라벨이 `약세`** 일 때만 자른다. GEN 2에서 확인: BTC[고변동]·ETH[강세]는
유지, SOL[약세]는 제외. 세대당 임대료 총 ₩110,317 (개체 18).

워커가 알던 코인이 BTC/ETH/XRP/SOL/DOGE 5개뿐이라 알트(ONG·FLOCK·ENA·UNI)는
보고서에서 "no data"였다 — 워커 `extractCoins`를 Upbit KRW 마켓 전체(10분 캐시)로
넓혔다.

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

변이·병합·분기를 넣은 뒤 9세대까지 이어 돌린 실제 사건(발췌):

```
MUTATED ORION-01 — rebalanceDays 9→12, peerAlloc 0.1588→0.3796 (pygad@3.7.0, rate 10%, diversity 0.318)
MUTATED XENO-01 — pBullMin 0.1116→0.0906, topK 5→1 · BALANCED → CONCENTRATOR
MERGED HALO-01 → ZEPHYR-01 — delegates 25% to a peer 3.66 fitter · capital now ₩1,287,323, genome blended 24/76
MERGED PIKE-02 → DUNE-02 — genomes nearly identical (distance 0.045)
FORKED VEGA-01 → VEGA-01/A (exposureMax=0.4297) | VEGA-01/B (exposureMax=0.8297) — two tribes, ₩1,101,810 each
FORKED TERRA-01 → TERRA-01/A (topK=2) | TERRA-01/B (topK=6)
RETIRED EMBER-01 [TREND_RIDER] — outcompeted — bottom 20% for 3 generations (fitness 1.2508)
```

9세대 시점 계통 13개(창세 6 + 분기 가지 7), 다양성 0.32(변이율 상승 없음).

## 시험지가 세대마다 다르다 (2026-09-03)

이전엔 시험 구간이 항상 가장 최근 60일이었다. 세대가 6시간마다 도니 시험지는 세대마다
6시간씩만 밀렸고, "3세대 연속 하위 20% 도태"는 같은 시험의 재채점이었다 — 그 창에 대한
과적합과 적합성을 가를 수 없었다. 유전 알고리즘이 운과 적합성을 가르는 힘은 **세대마다
다른 시험지**에서 나온다.

지금은 (`evaluate.ts`의 `pickExamWindow`, 순수 함수·테스트됨):

- 캔들 시리즈가 200일 → **365일**로 늘었고(`scanner-server.ts`의 `CANDLE_DAYS`), 세대마다
  훈련 최소 80일 뒤에서 60일 창의 시작을 세대 시드로 무작위로 뽑는다(선택지 ≈ 225개).
  직전 세대 창과 30일 이내면 다시 뽑는다.
- HMM은 **그 창 앞까지만** 적합하고(`buildFeatures(series, 60, start)`) 창 안은 forward
  filter만 — 창 안에 미래 정보가 없는 것은 전과 같다.
- 한 세대 안에서는 전원이 같은 창을 본다(순위 비교는 여전히 공정). 세대를 가로지르는
  적합도는 절대값이 아니라 **그 창을 본 개체들 사이의 순위**로 읽어야 한다 —
  `fitnessHistory[].window`와 `GenerationRecord.examWindow`에 창이 남는다.
- **실전 타깃(`lastWeights`)은 시험 창이 아니라 최신 데이터**에서 다시 계산한다. 과거 창의
  마지막 리밸런스를 오늘 배치하면 안 되기 때문이다. 자본 마킹도 최신 캔들로 한다.

## 정직성 규칙

- 시험지는 항상 훈련 구간 밖. HMM 파라미터는 훈련 구간에서 고정.
- 자본은 실캔들 수익으로만 움직인다. 세대 안에서 같은 날을 두 번 세지 않는다.
- PyGAD가 실제로 돌았는지 `engine` 필드가 말한다. 내장 대체는 이름을 바꾸지 않는다.
- 전부 페이퍼. 실돈 경계는 `CRYPTO_TRADE_ALLOW_REAL`이 그대로 지킨다.
