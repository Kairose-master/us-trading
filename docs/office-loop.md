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
