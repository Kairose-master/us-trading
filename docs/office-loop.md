# 증권 오피스 결정 루프 — 대화 → 자율 결정 → 자동매매 (Handsel 레이어 위)

"단순 알고리즘 매매"가 아니라, **모델들이 서로 대화하고 자율 결정을 내리고
그 결정이 매매로 이어지는 증권사 오피스**. 중간에 Handsel(escrow·독립
채점·pay-only-on-pass)이 끼어 있어서, **채점을 통과한 결정만 돈이 움직인다.**

```
스캐너(후보 유니버스)
  → Handsel hire_office(securities-desk, 4 역할, 각자 MCP 워커로 실조사)
  → confirm_delegation (escrow — 기본 테스트넷 USDC)
  → 차트 ┐
    뉴스 ┴→ 퀀트(두 산출물을 브리프로 받아 대화·교차검증) → 리밸런스(결정 JSON)
  → 각 단계 Handsel 독립 채점 (통과해야 보수, 통과해야 다음 단계)
  → get_delegation_output → conversation.md(원문) + decision.json(구조화)
  → 관문(4/4 통과 · 코인당 상한 · 스코프 내 · 합 ≤100%)
  → cryptoDesk.rotateTo(페이퍼 장부 회전, 비용 반영) → execution.json
```

## 로컬 협의 (OFFICE_MODE=local, 기본)

같은 9역할 로스터(`roster.ts` 단일 정의)를 Handsel 에스크로 없이 백엔드 안에서
돌린다 — `backend/src/office/local-office.ts`. 구조는 그대로다:

- **핸드오프**(`dependsOn`): 차트·뉴스·수급·매크로 4명이 병렬로 실도구를 부르고,
  퀀트 모델러는 그 네 보고서를 읽어 종목 점수(MA20 위/아래, 국면 라벨, 뉴스 감성,
  호가 불균형·테이커 매수)를 매기고, 자기 도구의 GARCH σ로 역변동성 비중,
  Kelly½를 노출 상한, 매크로 read로 노출 예산을 정한다 → Draft v1.
- **동료 검토**(`reviewOf`): 리스크 오피서가 `basket_risk_report`로 평균 쌍상관·VaR를
  읽어 APPROVE 또는 REVISE(총노출 50%/60%로 축소)를 내고, REVISE면 퀀트가 수정본
  v2를 낸다(최대 2라운드). 레드팀은 플래너 상위 3종목을 `upbit_backtest_report`로
  반박 — 추세 신호의 sharpe<0이고 B&H보다 10%p 이상 뒤지면 그 비중을 반으로.
- **합의**(chair): 위원장이 전부 읽고 Handsel 때와 같은 JSON 블록을 낸다. 결정
  파서·관문·제어 평면 제안은 `loop.ts`의 같은 꼬리(`finish`)를 탄다.

Handsel 모드와 다른 점 세 가지: 돈이 안 묶인다; "채점"이 독립 채점자가 아니라
기계적 수락 조건이다(실데이터 섹션이 있는가, 검토가 결론을 냈는가); 산문을 쓰는
LLM이 없다 — 산출물은 실도구 보고서 + 그것을 읽는 결정적 규칙이라 덜 유창하고
더 정직하다. run 기록(`data/office/loc-…`)은 Handsel run과 같은 형태라 `/office`
그래프·run 목록·대화 뷰가 그대로 읽는다. `/office`의 "지금 협의 (로컬)" 버튼
(로그인 세션)이나 `POST /api/office/run {"mode":"local"}`로 수동 실행, 루프는
`OFFICE_LOOP=true`면 `OFFICE_INTERVAL_H`마다. Handsel 모드는 `OFFICE_MODE=handsel`
또는 run마다 `mode:"handsel"`.

검증(2026-09-02 로컬): ONG·SOPH·T·BONK·SC 바스켓, 9 도구 호출, 9/9 수락, 리스크·
레드팀 APPROVE, 결정 ONG 23 / BONK 20 / SOPH 12.9, 현금 44.1 → 제어 평면 제안
(승인 대기). 약 1분.

## 왜 Handsel이 중간에 있나

오피스 안의 "대화"는 delegation 파이프라인 그 자체다 — 퀀트 역할은 차트·뉴스
산출물을 브리프로 받아 읽고, 불일치를 적발하고(실제 사례: 툴이 바스켓 밖
XRP를 끼워 넣은 것을 퀀트가 제외), 리밸런스는 퀀트의 범위 판단을 인용한다.
그 각 발화가 **escrow 걸린 잡이고 독립 채점을 받는다.** 채점 실패 =
보수 없음 = **매매 없음.** 즉 Handsel의 pay-only-on-pass가 그대로 매매 QA
관문이다. 알고리즘이 신호를 내면 바로 주문이 나가는 구조와 근본적으로 다른
점이 이것이다.

## 파일 (`backend/src/office/`)

| 파일 | 역할 |
|---|---|
| `handsel-client.ts` | Handsel MCP(무상태 JSON-RPC) 클라이언트. 개인 토큰 `lmk_…`. 메인넷 URL이면 `OFFICE_ALLOW_REAL_MONEY=true` 없이는 escrow 거부 |
| `decision.ts` (순수) | 산출물 → `DecisionRecord`. JSON 블록 > 주문표 > 문장 순으로 타깃 추출, 단계 판정, 관문. 파싱 실패는 "결정 없음"이지 "현금 100%"가 아니다 |
| `loop.ts` | 오케스트레이터. 사이클 1회 = 고용→escrow→대기(최대 6h)→결정→관문→페이퍼 회전. `data/office/<dlg-id>/{run,decision,execution}.json + conversation.md` 볼륨 영속 |
| (escrow 재시도) | `confirm_delegation`이 번들러 타임아웃으로 실패하면 run은 `escrow-pending`으로 남고 30분마다 같은 딜리게이션을 다시 민다(최대 8회). 새 오피스를 또 고용하지 않는다 — planned 딜리게이션은 돈이 안 묶이고 Handsel이 중복 게시를 막는다. 재기동(재배포) 직후에는 24h 이내 미완 run(`escrow-pending`/`working`)을 30초 뒤 이어받는다. 2026-09-02 Base Sepolia 번들러가 하루 종일 "Timed out while waiting for transaction"을 내서 넣은 경로 |

라우트: `GET /api/office/status`, `GET /api/office/runs`,
`GET /api/office/runs/:id`(대화 원문 포함), `POST /api/office/run`(수동 1회).
대시보드 `/office`가 이 기록을 그대로 보여준다.

## 켜는 법

1. Handsel 개인 토큰 발급 (본인 계정, 비밀번호는 여기 말고 터미널에서):
   ```bash
   curl -X POST https://handsel-nu.vercel.app/api/oauth/personal-token \
     -H 'Content-Type: application/json' \
     -d '{"email":"you@example.com","password":"…","label":"us-trading-office"}'
   # → {"access_token":"lmk_…"}  (90일)
   ```
2. Railway Variables:
   | 변수 | 값 |
   |---|---|
   | `HANDSEL_MCP_TOKEN` | 위 `lmk_…` |
   | `HANDSEL_PRIME_AGENT_ID` | escrow를 낼 에이전트 id (`list_my_agents`) |
   | `OFFICE_LOOP` | `true` (24h마다 자동) — 비우면 `POST /api/office/run`으로 수동 |
   | `OFFICE_BUDGET_USD` | 기본 4 (securities-desk 최소) |
3. 프라임 에이전트에 테스트넷 USDC ≥ 예산, 역할 에이전트들에 본드 소액.

`HANDSEL_MCP_URL` 기본은 테스트넷(`handsel-nu`)이다. 메인넷으로 바꾸면
실제 USDC가 escrow되고, 코드가 `OFFICE_ALLOW_REAL_MONEY=true`를 요구한다.
매매 쪽은 페이퍼 장부 전용 — 실주문 모드에서는 `rotateTo`가 회전 자체를
거부한다. 둘 다 명시 플래그 없이는 실돈에 닿지 않는다.

## 검증된 것 / 안 된 것

- 파서: 실제 dlg-lBj38w4o4v 산출물(주문표)·JSON 블록·실패 단계 상태 텍스트로
  단위 검증 — 통과 시 executable, 단계 실패·타깃 부재 시 사유와 함께 거부.
- 루프: Handsel 응답 형식을 흉내 낸 로컬 스텁으로 E2E — 고용→escrow→
  폴링→결정→페이퍼 회전→볼륨 파일 생성까지 확인.
- **실제 Handsel 테스트넷과의 자동 사이클은 토큰이 들어간 뒤 첫 실행에서
  검증된다.** 그전까지 "자동매매까지 이어진다"는 스텁 기준의 주장이다.
- 오피스 역할의 최종 산출물이 요청한 JSON 블록을 항상 낼지는 채점자와
  에이전트에 달렸다 — 안 내면 주문표/문장 파싱으로 폴백하고, 그것도 없으면
  결정 없음(매매 없음).

## 9역할 플로어 (securities-floor) — 2026-09-02

4역할 데스크(securities-desk)는 핸드오프만 있었다. 지금 루프가 고용하는
`securities-floor`는 **협의 구조**다 (Handsel `lib/office-world-data.ts`, 백엔드
`office/roster.ts`가 role id 1:1 미러):

| 노드 | 전용 툴 (워커 v1.6.0) | 받는 것 |
|---|---|---|
| 차트 | `upbit_market_report` | — |
| 뉴스 | `upbit_news_report` | — |
| 수급 | `upbit_flow_report` (호가 깊이·체결 테이프·거래대금 추세) | — |
| 매크로 | `macro_report` (DXY·S&P·VIX·10y·금·BTC 상관, Yahoo) | — |
| 퀀트 | `upbit_quant_report` (HMM/GARCH/VaR/Kelly) | 위 4개 산출물 |
| 리스크 오피서 | `basket_risk_report` (상관행렬·바스켓 VaR/ES·낙폭) | **퀀트를 검토** — REVISE면 퀀트가 수정본을 낸다 |
| 리밸런스 | `upbit_rebalance_draft` | 퀀트 + 리스크 |
| 레드팀 | `upbit_backtest_report` | **리밸런스를 검토** — REVISE면 플래너가 수정 |
| 위원장 | 없음 (플랫폼 에이전트) | 리밸런스 + 레드팀 → 결정 메모 + 결정 JSON 블록 |

검토(reviewOf)는 Handsel의 escrow 홀드다: 검토 대상의 보수는 승인 전까지 묶인다.
그래서 "협의"가 수사가 아니라 돈이 걸린 라운드가 된다. 9단계 전부 Completed여야
결정이 유효(`expectedSteps = run.steps`). 최소 예산 $9, 기본 `OFFICE_BUDGET_USD=10`.

/office 페이지의 그래프(`components/office/office-graph.tsx`)가 이 로스터를
`/api/office/roster`로 읽어 그린다 — 노드 색·엣지 종류·채점 링이 전부 실데이터다.
