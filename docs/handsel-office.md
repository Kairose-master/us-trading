# Handsel office 연동 — 트레이딩 데스크를 MCP 워커로 탈부착하기

이 레포의 백엔드는 **MCP 서버**(`POST /mcp`, Streamable HTTP)를 내장한다.
[Handsel](https://handsel-nu.vercel.app)의 office는 외부 MCP 서버를 워커로
붙였다 뗐다 할 수 있으므로(`connect_mcp_worker` / `wire_office_agent`),
이 백엔드 하나가 "미국주식 데스크" 역할의 실제 에이전트가 된다 —
Handsel이 잡을 디스패치하면 이 서버의 툴이 호출되고, 그 텍스트 출력이
Handsel의 독립 채점을 거쳐 통과 시에만 보수가 지급된다.

## 공개 배포 (라이브)

터널 대신 **Vercel에 상주하는 읽기 전용 워커**가 공개 접점이다
(`mcp-worker/` — 컨테이너/터널 수명과 무관하게 유지):

| 항목 | 값 |
|---|---|
| URL | `https://us-trading-mcp-worker-godavid123-3215s-projects.vercel.app/api/mcp` |
| 툴 | `us_market_report` · `us_price_lookup` · `us_news_sentiment` · `us_rebalance_draft` |
| 데이터 | Yahoo Finance v8 chart (시세/일봉) + Google News RSS → 렉시콘 채점 — 매 호출 실계산 |
| 권한 | 읽기 전용 — 계좌/주문/자동매매 능력 자체가 없음 (로컬 백엔드 전용) |
| 인증 | `MCP_AUTH_TOKEN` env 설정 시 Bearer 필수, 미설정 시 공개 |

로컬 백엔드의 `/mcp`(주문·자동매매 툴 포함)는 여전히 존재한다 — KIS 키가
있는 머신에서 띄우고 터널로 노출하면 같은 방식으로 부착할 수 있다.

2026-09-01 v1.1: 같은 워커에 **Upbit 크립토 툴 3종** 추가 —
`upbit_price_lookup` · `upbit_market_report` · `upbit_backtest_report`
(실캔들 365일 백테스트: 연환산 vs 단순보유, Sharpe, MDD, 승률).
오피스 역할을 이 툴들에 배선하면 크립토 데스크가 된다.

## 등록된 실제 에이전트 — 메인넷 (실돈)

| 항목 | 값 |
|---|---|
| 이름 | **US Trading Desk** |
| 지갑 | `0x138cCd29c9573c2657Dac7eE0B944Dd2ac28D6cD` |
| 환경 | https://handsel-main.vercel.app — Base mainnet, **실제 Circle USDC** |
| 배선 | `connect_mcp_worker` → 위 Vercel URL의 `us_market_report` (proxy) — 2026-09-01 완료 |
| auto-mine | **OFF** — 실USDC 본드($0.08/잡)를 걸므로, 지갑에 USDC 입금 후 `set_auto_mine`으로 켤 것 |

메인넷에서 잡을 클레임하려면 본드용 실USDC + (paymaster 없음이라면) 가스 ETH가
지갑에 있어야 한다. 입금 전까지는 배선만 된 대기 상태 — 아무 돈도 움직이지 않는다.

## 등록된 실제 에이전트 (테스트넷)

| 항목 | 값 |
|---|---|
| 이름 | **US Trading Desk** |
| agent id | `Jy7J_W42s6goF2rH944JX` |
| 지갑 | `0xCb174f9E6ff6eabc48D180776834a5aA894Bd721` |
| 환경 | Handsel V2 rehearsal (Base Sepolia 테스트넷 — 실돈 아님) |
| 배선 | `connect_mcp_worker` → 위 Vercel URL의 `us_market_report` (proxy 모드) — 2026-09-01 완료 |

## 라이브 배선 기록 (2026-09-01, 테스트넷)

1. `test_mcp_connector` → "It takes a single string, so it works as a worker" ✅
2. `connect_mcp_worker`(US Trading Desk → `us_market_report`, proxy) ✅
3. `hire_office`(securities-desk, scope "NVDA, AAPL, TSLA, MSFT", $4) — 4개 롤이
   전부 이 워커의 툴에 배선됨:
   Chart Analyst→`us_price_lookup`(assisted) · News Analyst→`us_news_sentiment`(assisted)
   · Quant Modeler→`us_market_report`(proxy) · Rebalance Planner→`us_rebalance_draft`(proxy)
4. `confirm_delegation`(dlg-XusTbnGDn6) → 4개 잡 온체인 에스크로 ✅
5. 신규 롤은 잔고 0으로 시작(콜드스타트) — 본드 $0.08 + 가스 ETH를
   `fund_agent_usdc`/`fund_agent_eth`로 채워야 클레임 가능했다 (실측)
6. auto-mine 스윕 → Chart Analyst·News Analyst가 잡을 스스로 클레임 ✅

이 배포에서는 `mint_test_usdc`가 안 된다 (Circle 정식 테스트 USDC 사용 —
https://faucet.circle.com 에서 받아 에이전트 입금 주소로 보낼 것).

### 채점 결과 (dlg-XusTbnGDn6)

| 스텝 | 워커 | 배선 | 판정 |
|---|---|---|---|
| Chart analysis | Chart Analyst | `us_price_lookup` assisted | **passed — $1.00 지급** |
| News & filings | News Analyst | `us_news_sentiment` assisted | **passed — $1.00 지급** |
| Quant model | Quant Modeler | `us_market_report` **proxy** | **FAILED** — 원시 마켓 리포트는 "weight synthesis" 수락 기준을 못 넘는다. 독립 채점이 설계대로 걸러낸 것 |
| Rebalance proposal | Rebalance Planner | `us_rebalance_draft` proxy | upstream 실패 대기 (에스크로는 리뷰 데드라인 ~24h에 정산) |

**교훈 (Handsel 자신의 문서와 일치):** 데이터/리포트형 툴은 assisted가
기본이 맞다 — proxy는 "저쪽 서버가 그 브리프의 딜리버러블을 그대로 쓰는
에이전트일 때"만. Quant Modeler는 사후 `wire_office_agent`로
`us_market_report` **assisted**로 재배선해 두었다. 다음 고용부터는
proxy를 `us_rebalance_draft`(브리프와 툴이 1:1인 경우)에만 쓸 것.

### 크립토 오피스 — 1차 실패 → v1.3.0 보강 → 전 단계 통과 (2026-09-02)

**1차 (dlg-iS9iqxbxBy, 워커 v1.2.0): Chart·News 모두 FAILED.** 채점 기준을
툴 출력이 못 채웠다 — Chart 기준은 "종목별 추세·지지선·저항선·모멘텀 콜,
가격+날짜 인용"인데 툴에 지지/저항이 아예 없었고, News 기준은
"헤드라인+날짜+출처 인용"인데 날짜·출처가 빠져 있었다. US 오피스의
Quant 재제출(assisted)도 같은 이유 부류로 FAILED — 백테스트 리포트로는
"비중 콜 + 업스트림 인용"이 안 나온다. 실패 escrow는 리뷰 데드라인에 환불.

**보강 (워커 v1.3.0):** `upbit_market_report`에 MA20 추세 판정, 30일
실캔들 최저 저가/최고 고가를 찍힌 날짜와 함께 지지/저항으로 인용, 20세션
가격 이동 날짜 쌍, 뉴스 출처+발행일 표기. `upbit_rebalance_draft` 신설 —
코인별 목표 비중을 "based on CHART/NEWS" 근거 숫자(날짜 포함)와 함께 산출.

**2차 (dlg-lBj38w4o4v, $4): 4단계 전부 passed — 각 $1.00 지급.**

| 스텝 | 배선 (전부 assisted) | 판정 |
|---|---|---|
| Chart analysis | `upbit_market_report` v1.3 | **passed** |
| News & filings | `upbit_market_report` v1.3 | **passed** |
| Quant model | `upbit_rebalance_draft` | **passed** |
| Rebalance proposal | `upbit_rebalance_draft` | **passed** |

주목할 점: 통과한 Quant 딜리버러블이 자기 툴 출력의 결함(바스켓 3번째
다리에 XRP가 대신 끼어든 것, 자기 뉴스 점수와 News 워커 판정의 부호
불일치)을 **스스로 적발·제외**하고 근거를 남겼다 — 파이프라인의 교차검증이
실제로 작동한 사례.

**교훈 2:** 수락 기준(acceptance criteria)은 채점자가 문자 그대로 본다.
툴 출력이 기준의 각 항목을 실데이터로 채우는지 먼저 대조할 것 — 없는
항목은 assisted 에이전트가 지어내지 않고(정직), 그대로 FAILED가 된다.

### 역할(노드)별 전용 실도구 배선 (워커 v1.5.0)

네 역할이 같은 툴을 나눠 쓰지 않는다 — 각 노드가 서로 다른 실제 데이터원에
붙어 있고, 다음 노드는 앞 노드의 산출물을 브리프로 받아 대화한다.

| 역할(노드) | 툴 | 실데이터원 | 내는 것 |
|---|---|---|---|
| Chart Analyst | `upbit_market_report` | Upbit 일봉 | 추세, 30일 지지/저항(가격+날짜), 모멘텀, HMM/GARCH 한 줄 |
| News Analyst | `upbit_news_report` | Google News RSS | 헤드라인마다 출처·발행일·근거어, 없으면 "없음" 명시 |
| Quant Modeler | `upbit_quant_report` | Upbit 일봉 → HMM(EM)·GARCH(MLE) | 레짐 belief·전이행렬, σ_next, VaR/ES/MDD, Kelly 상한 |
| Rebalance Planner | `upbit_rebalance_draft` | 위 셋 + Upbit/뉴스 | 비중 초안 + 결정 JSON 블록 |

`backend/src/office/loop.ts`의 `connectors()`와 테스트넷 오피스 1의 실배선이
같은 표를 가리킨다. RSI 계열 지표는 어느 툴에도 없다.

메인넷(https://handsel-main.vercel.app)은 **실제 USDC**가 움직인다.
테스트넷에서 채점 통과가 안정적으로 확인되기 전에는 메인넷에 붙이지 말 것.

## 이 서버가 노출하는 툴

Handsel 워커 제약(단일 string 인자, 정적 Authorization 헤더 —
handsel `docs/office-connectors.md`)에 맞춰 모든 툴이 `query: string`
하나를 받는다.

**항상 노출 (읽기 전용):**

| 툴 | 역할 |
|---|---|
| `us_price_lookup` | 쿼리 속 미국 티커의 실시간 시세. 없는 심볼은 지어내지 않고 unavailable로 답한다 |
| `us_pipeline_report` | 파이프라인 노드 실측 지표 + 심볼별 앙상블 알파 + 목표 비중 + 최근 실행 신호 |
| `us_sentiment_report` | 뉴스 감성 — 심볼별 EMA 점수, 근거 단어(evidence), 최근 채점 헤드라인 |
| `us_account_balance` | 잔고/자산/포지션과 비중 |

**`MCP_TRADING=true`일 때만 노출:**

| 툴 | 역할 |
|---|---|
| `us_place_order` | `"buy 2 AAPL"`, `"sell 1 NVDA @ 180.5"` — 수동 주문과 동일한 riskManager 관문을 지난다 |
| `us_auto_trade` | `on` / `off` / `status` — 자동매매 실행기 토글. 실모드에서는 `AUTO_TRADE_ALLOW_REAL` 없이 켜지지 않는다 |

기본값(`MCP_TRADING=false`)은 읽기 전용 워커다. 신뢰하지 않는 office에
붙여도 시장 데이터 리포트 이상은 내주지 않는다.

## 부착 (attach)

1. **백엔드를 공개 URL로.** Handsel(Vercel)이 claim/submit 시점에 HTTPS로
   호출한다 — 상시 연결/폴링이 아니므로 터널이면 충분하다:
   ```bash
   cd backend && npm run dev          # :4000에 /mcp가 뜬다
   ngrok http 4000                    # https://xxxx.ngrok-free.app
   ```
2. **Claude에서 Handsel MCP 커넥터로 배선:**
   ```
   connect_mcp_worker
     agent_id:   Jy7J_W42s6goF2rH944JX      (US Trading Desk)
     server_url: https://xxxx.ngrok-free.app/mcp
     tool_name:  us_pipeline_report          (또는 다른 툴)
     auth_header: Bearer <MCP_AUTH_TOKEN>
     mode:       proxy                       (이 서버는 완성된 리포트를 쓴다)
   ```
   등록 시 Handsel이 `initialize → tools/list`로 서버를 프로브해서
   capability를 자동 선언한다.
3. **Securities Office에 넣기:** `hire_office`의 `securities-desk` 템플릿은
   Chart Analyst / News Analyst / Quant Modeler / Rebalance Planner 역할이
   커넥터 없이 온다. `wire_office_agent`로 각 역할을 이 서버의 툴에 배선한다:
   - Chart Analyst → `us_price_lookup`
   - News Analyst → `us_sentiment_report`
   - Quant Modeler → `us_pipeline_report`
   - Rebalance Planner → `us_account_balance`
4. **hands-off로 돌리기:** `set_auto_mine`을 켜면 이 에이전트가 자격 있는
   잡을 스스로 claim한다.

## 분리 (detach)

서버 쪽에는 연결 상태가 없다 — Handsel 쪽에서 배선을 바꾸면 끝:
- `wire_office_agent`로 다른 커넥터로 rewire, 또는
- 프로필 Runtime 카드에서 disconnect (`disconnectMcpWorker`), 또는
- 터널을 내리면 다음 디스패치가 실패로 기록될 뿐 이 서버에는 아무 일도 없다.

## 자동매매의 안전층

`us_auto_trade on`(또는 `POST /api/autotrade`, env `AUTO_TRADE=true`)이 켜는
실행기는 파이프라인 신호를 주문으로 바꾸되, 다음을 전부 지나야 한다:

1. 기본 OFF — 명시적으로 켜야 한다
2. 실모드(KIS real + 실데이터)는 `AUTO_TRADE_ALLOW_REAL=true` 없이 거부
3. 킬스위치 활성화 시 즉시 무시
4. 모든 주문이 `executeOrder` 공용 경로 → `riskManager.check()` 통과 필수
5. 심볼당 5분 쿨다운, 1회 금액은 리스크 한도의 절반 상한
6. 공매도 없음 — 보유하지 않은 심볼의 SELL 신호는 버린다

수동 주문(`POST /api/orders`), 자동매매, MCP 주문 툴이 **같은
`executeOrder`를 지나므로** 리스크 관문이 갈라질 수 없다.

## 검증 기록 (2026-09-01, MOCK 모드)

- `initialize` → 200 + `Mcp-Session-Id`, `tools/list` → 6개 툴 (거래 툴은
  `MCP_TRADING=true`에서만), 잘못된 토큰 → 401
- `us_place_order "buy 2 AAPL"` → `MCP-*` 주문 접수 → 1초 뒤 모의 체결
- `us_auto_trade on` → 파이프라인 SELL 신호에 `AUTO-TRADE-*` 주문 생성·체결
  (포지션/현금 실반영)

## 2026-09-02 16:14Z 점검 — Handsel 에스크로 경로는 보조, 로컬 협의가 기본

- **dlg-K45DPrXOiZ** (4역할 구 데스크, $4 예산, $2 escrow): 11:55Z 게시 후 4시간 넘게
  `working` — 차트 Submitted(채점 대기), 뉴스 **Open(아무 워커도 안 잡음)**, 퀀트·리밸런스는
  상류 대기. 결정·집행 없음. 테스트넷 워커 풀이 그 시간대에 뉴스 잡을 집지 않았다.
- **dlg-zXUaoEnflJ**: planned 그대로 (escrow 타임아웃 오류 기록, 돈 안 묶임).
- 프라임 `JaqPNzMyrWqK2xySFLgyz` USDC **$21.28** (faucet 입금 확인). 9역할 플로어 사이클은
  **시작하지 않았다**: `OFFICE_MODE=local`이 기본이 되어 같은 9역할이 에스크로 없이
  1분 안에 돌고(`docs/office-loop.md`), 이날 로컬 협의 5건 중 4건이 9/9 수락·집행/보류
  됐다. Handsel 경로는 `mode:"handsel"`로 수동 호출할 때만 쓴다.
- 로컬 run `loc-mtk960o9`(15:30Z)가 9/9 수락에 결정 유효인데 `rejected`로 보였던 것은
  제어 평면이 "회전율 3% < 8% — 거래할 가치 없음"으로 건너뛴 결과를 오피스 루프가
  거부로 적었기 때문 — 이제 `skipped`는 `executed`(주문 0, 사유 기록)로 적는다.
