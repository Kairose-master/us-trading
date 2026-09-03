# 바퀴를 다시 만들지 않기 — 기존 퀀트 라이브러리 조사 (2026-09-03)

이 레포는 퀀트 프리미티브를 **직접 짰다**. 3,000줄 남짓:

| 우리가 짠 것 | 줄 | 무엇 |
|---|---|---|
| `evolution/population.ts` + `ga.ts` + `evaluate.ts` | 862 | GA 개체군, 워크포워드 시험 |
| `crypto/scanner.ts` | 290 | 유니버스 스코어링(모멘텀/변동성/HMM) |
| `crypto/backtest.ts` | 248 | 백테스트 엔진 + 비용 모델 |
| `crypto/upbit.ts` | 204 | Upbit 클라이언트, 토큰 버킷, 재시도 |
| `ml/tune.ts` + `train.ts` + `validate.ts` | 377 | 랜덤서치 튜너, 로지스틱 SGD, 워크포워드 |
| `quant/regime.ts` | 180 | HMM(3상태) Baum-Welch + 포워드 필터 |
| `quant/garch.ts` | 100 | GARCH(1,1) MLE |
| `quant/{risk,stats,allocator}.ts` | 223 | VaR/ES/Kelly, Sharpe/MDD, 지수가중 |

**전부 이미 있는 것들이다.** 아래는 무엇이 있는지, 무엇을 바꿔야 하는지, 그리고
바꾸지 **말아야** 하는 것이 무엇인지의 기록이다.

## 언어 경계 — 이 조사의 핵심 제약

성숙한 퀀트 스택은 **전부 파이썬**이다. 우리 백엔드는 TypeScript다. JS 쪽 대안을 실제로
찾아봤고, 결론은 "없다":

| npm 패키지 | 최신 | 판정 |
|---|---|---|
| `ccxt` | 4.5.77 (2026-09-01, MIT) | **살아있다. 쓸 것** |
| `simple-statistics` | 7.11.0 (2026-08-29, ISC) | 살아있지만 기초 통계뿐 — GARCH·HMM 없음 |
| `danfojs-node` | 1.2.0 (2025-04) | pandas 흉내, 퀀트 기능 없음 |
| `technicalindicators` | 3.1.0 (**2020-03**) | 죽었다. 게다가 우리는 지표를 안 쓴다 |
| `portfolio-allocation` | 0.0.11 (**2020-10**) | 죽었다 |

그러니 선택지는 셋이다:
1. **ccxt만 JS로 채택** — 같은 언어, 위험 없음.
2. **파이썬 사이드카** — 이미 있다. `Dockerfile`이 `python3 + pygad + numpy`를 설치하고
   `ga.ts`가 `spawn("python3", …)`으로 부르며, 파이썬이 없으면 내장 연산자로 폴백하고
   결과에 `engine`을 적는다. 그 패턴을 그대로 늘리면 된다.
3. **오프라인 검증 리그** — 라이브 루프는 그대로 두고, "이 규칙에 우위가 있나"만
   파이썬 스택으로 답한다.

## 모듈별 대응표

| 우리 코드 | 대체 | 무엇을 얻나 | 판정 |
|---|---|---|---|
| `crypto/upbit.ts`(토큰 버킷·재시도·마켓/티커/캔들) | **ccxt** (MIT, JS/TS 네이티브, Upbit 지원, 거래소별 레이트리밋 내장) | 우리가 429 때문에 두 번 고친 그 로직을 남이 유지보수 | **채택 권고** — 같은 언어, 즉시 |
| `quant/garch.ts` (직접 짠 MLE) | **arch** (Kevin Sheppard) | GARCH/EGARCH/GJR, 표준오차, 예측 구간 | 사이드카로 채택 |
| `quant/regime.ts` (직접 짠 Baum-Welch) | **statsmodels** `MarkovRegression` / **hmmlearn** | 검증된 추정, 수렴 진단 | 사이드카로 채택 |
| `quant/{risk,stats}.ts` | **quantstats(-reloaded)** / **empyrical-reloaded** | Sharpe/Sortino/Calmar/VaR/ES/MDD + 티어시트 | 사이드카로 채택 |
| `quant/allocator.ts` + 오피스의 역변동성 가중 | **skfolio**(sklearn API, CVXPY 백엔드) / **Riskfolio-Lib**(24개 리스크 척도, HRP/NCO) / **PyPortfolioOpt** | HRP, CVaR·MAD·드로다운 목적함수, 블랙-리터만 | 사이드카로 채택 |
| `ml/tune.ts` (랜덤서치 + 좌표 정련) | **Optuna** (TPE) | 과거 시행에서 배우는 탐색, 가지치기 | 사이드카로 채택 |
| `crypto/backtest.ts` | **vectorbt** / **Backtesting.py** / **NautilusTrader** | 벡터화 파라미터 스윕, 검증된 체결 모델 | **오프라인만** — 라이브 경로는 안 바꾼다 |
| `evolution/ga.ts` | PyGAD | — | **이미 채택함** |

## 지금 가장 아픈 곳에 정확히 대응하는 것 두 개

이 조사에서 제일 중요한 발견은 포트폴리오 최적화가 아니라 **"우위가 진짜인가"를 재는
도구**다. 우리가 반복해서 틀린 지점이 정확히 거기다.

**1. `arch.bootstrap`의 다중비교 절차 — SPA / StepM / MCS.**
`scanner.ts`는 이미 스스로 이렇게 적어 뒀다: *"27개 코인을 훑은 것 자체가 27번의 암묵적
검정"*. 그 문장을 검정으로 바꾸는 것이 SPA(Hansen, White의 Reality Check 개선판)다.
벤치마크(BTC 보유) 대비 최고 성과가 **데이터 스누핑으로 설명되는지**의 p값을 준다.
StepM은 벤치마크를 실제로 이긴 모델 집합을, MCS는 벤치마크 없이 "구분 불가능한 최상위
집합"을 준다. 오피스의 레드팀 데스크가 지금 하는 일(백테스트 하나 돌려보기)의 제대로 된
버전이다.

**2. Deflated Sharpe Ratio (Bailey & López de Prado).**
진화 캠페인은 세대마다 개체 7~25개를 채점하고 최고를 챔피언으로 삼는다. **시행 횟수만큼
챔피언의 Sharpe는 부풀려져 있다.** DSR은 시행 수·왜도·첨도로 그 부풀림을 깎는다.
"시험지를 세대마다 바꾼다"로 고친 것의 정량판이고, `docs/evolution.md`가 적어 둔 한계를
숫자로 만든다. 관련해서 **purged K-fold / CPCV**(López de Prado, `mlfinlab` 또는
`skfolio` 구현)는 `ml/validate.ts`의 워크포워드가 라벨 겹침을 처리 못 하는 문제의 답이다.

## 우리와 가장 많이 겹치는 제품: freqtrade

**freqtrade** (53k★, 파이썬, 2026.7 릴리스)는 우리 페이퍼 트레이딩 루프가 하는 일을
거의 그대로 한다 — 드라이런, 백테스트, hyperopt, FreqAI(적응형 재학습), 텔레그램 제어,
10+ 거래소. 정직하게 말하면 **`crypto/desk.ts` + `scanner.ts` + `ml/tune.ts`는
freqtrade의 부분집합**이다.

그럼에도 통째로 갈아타지 **않는** 이유는 하나다: freqtrade에는 우리 제품의 실제 내용인
**에이전트 층**이 없다. 매니지먼트 협의회, 9역할 오피스 협의, 진화 개체가 MCP 데스크를
임대료 내고 빌려 쓰는 구조, Handsel 에스크로 잡, 귀속·벤치마크 대시보드 — 이건 어디에도
없다. 바퀴는 퀀트 프리미티브 쪽이지 이쪽이 아니다.

## 권고 — 순서대로

1. **ccxt로 `upbit.ts` 교체** (JS, MIT, 위험 최소). 우리가 두 번 고친 레이트리밋·재시도를
   남에게 넘긴다. 캔들 저장소·유니버스 층은 그대로.
2. **파이썬 검증 사이드카 하나** — `Dockerfile`에 `arch statsmodels quantstats scipy` 한 줄
   추가(이미 python3+numpy 있음), `backend/quant/verify.py` 하나. 답하는 질문은 둘:
   (a) 이 규칙이 BTC 보유를 이겼는가 — **SPA p값**, (b) 챔피언 Sharpe가 시행 수를 감안하면
   유의한가 — **DSR**. 오피스 레드팀 데스크와 진화 챔피언 리포트가 이걸 부른다.
   PyGAD와 같은 폴백 규칙: 없으면 지금 코드로 돌고 결과에 `engine`을 적는다.
3. **`quant/*.ts`는 그 사이드카가 검증될 때까지 남긴다.** 지금 도는 코드를 먼저 지우지
   않는다 — 대체가 같은 숫자를 내는지 확인한 뒤 지운다.
4. **vectorbt/freqtrade는 오프라인 리그로만.** 스캐너의 모멘텀 규칙에 우위가 있는지
   1년치로 스윕해 보는 용도. 라이선스 주의: **vectorbt는 Apache-2.0 + Commons Clause**라
   "이 소프트웨어가 주된 내용인 제품"의 판매를 금지한다. 지금 용도(내부 검증)는 무관하지만
   제품에 넣을 것은 아니다. freqtrade는 GPL-3.0.
5. **바꾸지 않는 것**: 제어 평면, 협의회, 오피스, 진화의 에이전트 층, MCP/Handsel 연동,
   대시보드. 여기에 대응하는 라이브러리는 없다.

## 출처

- [awesome-quant](https://github.com/wilsonfreitas/awesome-quant) — 카테고리별 색인
- [arch (bashtage)](https://github.com/bashtage/arch) · [Multiple Comparisons](https://bashtage.github.io/arch/multiple-comparison/multiple-comparison_examples.html) — GARCH, SPA/StepM/MCS
- [Deflated Sharpe Ratio (Bailey & López de Prado)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551) · [purged CV](https://en.wikipedia.org/wiki/Purged_cross-validation)
- [skfolio](https://github.com/skfolio/skfolio) · [Riskfolio-Lib](https://github.com/dcajasn/Riskfolio-Lib) · [PyPortfolioOpt](https://github.com/robertmartin8/PyPortfolioOpt)
- [empyrical-reloaded](https://github.com/stefan-jansen/empyrical-reloaded) · [quantstats-reloaded](https://pypi.org/project/quantstats-reloaded/)
- [ccxt](https://github.com/ccxt/ccxt) · [Upbit CCXT 연동 가이드](https://global-docs.upbit.com/docs/ccxt-library-integration-guide)
- [freqtrade](https://github.com/freqtrade/freqtrade) · [vectorbt](https://github.com/polakowo/vectorbt) · [NautilusTrader](https://nautilustrader.io/)
- [Optuna](https://optuna.readthedocs.io/)
