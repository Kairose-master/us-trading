# KIS US Auto-Trading Backend

한국투자증권(KIS) Open API 기반 미국주식 자동매매 백엔드. v0/Lovable로 만든 프론트(`us-trading-dashboard-prompt.md` 스펙)와 짝을 이룬다.

## 빠른 시작

```bash
npm install
cp .env.example .env    # 값 채우기 (일단 MOCK_DATA=true면 KIS 키 없이도 동작)
npm run dev             # tsx watch 모드
```

- `MOCK_DATA=true`: KIS 없이 랜덤워크 목데이터로 기동 → 프론트 먼저 붙이기
- `KIS_MODE=mock` + `MOCK_DATA=false`: KIS **모의투자 서버**에 실제 연결
- `KIS_MODE=real`: 실전. **모의에서 충분히 돌려본 뒤에만.**

## 구조

```
src/
  index.ts            # 부트스트랩 + 전략 엔진 배선
  config.ts           # 환경변수 (mock/real 서버 분기, 계좌번호 파싱)
  kis/
    endpoints.ts      # ⚠️ 모든 TR ID/경로 한 곳에 집중 — 문서 검증 지점
    auth.ts           # 토큰 발급/캐싱 (KIS는 재발급 1분 1회 제한 → 캐싱 필수)
    client.ts         # REST 어댑터 (시세/차트/주문/잔고) + 레이트리미터 통과
    ws.ts             # KIS 실시간 WS 소비자 (재연결 + 구독 복구)
  core/
    rateLimiter.ts    # 토큰버킷 — 429 예방, 사용률 게이지 제공
    marketSession.ts  # America/New_York 기준 세션 계산 (DST 자동)
    logger.ts
  risk/riskManager.ts # 단일 관문: 수동/전략 주문 모두 check() 필수 통과
  strategy/
    engine.ts         # 전략 등록/시작/정지/틱 디스패치
    strategies/rsiReversal.ts  # 예시 전략 (배선 확인용)
  pipeline/
    engine.ts         # 실시간 데이터/ML 파이프라인 DAG (아래 섹션 참고)
    types.ts
  sentiment/
    news.ts           # 비정형 수집기 — Google News RSS (키 불필요) + MOCK 폴백
    scorer.ts         # 렉시콘 기반 헤드라인 채점 (결정적, LLM 불필요)
    tracker.ts        # 심볼별 신뢰도 가중 EMA + 채점 피드
  trade/
    execute.ts        # 주문 실행 공용 경로 — 수동/자동/MCP 전부 여기로 (리스크 관문 1회)
    auto-trader.ts    # 자동매매 실행기 — 파이프라인 신호 → 주문 (기본 OFF, 겹겹의 가드)
  ml/
    features.ts       # 캔들 → 피처 8종 + 라벨 (룩어헤드 없음, 순수)
    train.ts          # 로지스틱 회귀 미니배치 SGD — loss/스텝 전부 실측, 시드 고정
    validate.ts       # walk-forward 검증 — 신뢰할 숫자는 out-of-sample뿐
  crypto/
    upbit.ts          # Upbit 클라이언트 — 공개(키 불필요, 항상 실데이터) + JWT 개인(주문은 이중 스위치)
    desk.ts           # 크립토 데스크 — 두 번째 파이프라인 인스턴스, 페이퍼/실주문 3단 가드
    backtest.ts       # 알파 백테스트 엔진(순수) — 시그널 4종, 룩어헤드 없음, 롱/현금만
  mcp/
    server.ts         # POST /mcp — Handsel office가 이 백엔드를 워커로 탈부착하는 접점
    tools.ts          # 단일 string 인자 툴들 (거래 툴은 MCP_TRADING=true에서만)
  api/
    routes.ts         # 프론트 스펙 그대로의 REST
    wsRelay.ts        # /ws/live — 프론트용 릴레이
    state.ts          # 인메모리 상태 + 목 시뮬레이터 (+모의 체결)
```

## Handsel office 연동 + 자동매매

`docs/handsel-office.md` 참고 — 등록된 테스트넷 에이전트(US Trading Desk),
부착/분리 절차, MCP 툴 목록, 자동매매의 6겹 안전층이 거기 있다.

## 데이터/ML 파이프라인 (정형 + 비정형 통합)

정형 소스(시세 틱)와 비정형 소스(뉴스 헤드라인)를 하나의 DAG로 처리한다:

```
INGESTION            FEATURES            MODELS            STRATEGY        EXECUTION
시세 틱 ──────┬──▶ 기술적 지표 ─────▶ 기술 알파 ──┐
              └──▶ 마이크로구조 ──────┘            ├─▶ 알파 앙상블 ─▶ 포트폴리오 구성 ─▶ 실행 라우터
뉴스 스트림 ─────▶ 감성 점수 ────────▶ 감성 알파 ──┘
```

- **모든 노드 지표는 실측값** — 레이턴시는 `performance.now()`, 처리량은 최근 10초 창.
- 실행 라우터는 **신호까지만** 만든다. 신호도 `riskManager.check()`를 통과해야 하며,
  실제 주문 발행은 기존 주문 경로(kisClient)의 몫.
- 뉴스는 실모드에서 Google News RSS(키 불필요)를 심볼별로 폴링하고,
  MOCK_DATA/실패 시 합성 헤드라인으로 폴백한다 (`source` 필드로 구분).
- 감성 채점은 렉시콘 기반으로 결정적 — 점수에 기여한 단어가 `evidence`로 남아 감사 가능.

REST: `GET /api/pipeline` · `/api/pipeline/nodes/:id` · `/api/pipeline/logs`
· `/api/pipeline/targets` · `/api/pipeline/signals` · `/api/sentiment` · `/api/sentiment/feed`
WS 채널: `pipeline`(1초 스냅샷) · `pipeline:log` · `sentiment`

## 실연결 전 검증 체크리스트 (중요)

`src/kis/endpoints.ts`와 `client.ts`의 `⚠️` 주석 지점은 KIS Developers 공식 문서와 대조 필수:

- [ ] TR ID (실전/모의 각각) — 특히 해외주식 주문(TTTT1002U/1006U 계열)
- [ ] 시세 응답 필드명 (`output.last`, `output.base` 등)
- [ ] 실시간 WS 필드 인덱스 (HDFSCNT0 명세)
- [ ] 미국 시장가 주문 지원 여부 (미지원이면 지정가 강제 로직 유지)
- [ ] 주간/야간(프리·애프터) 주문 시 TR ID 또는 파라미터 차이

## 안전 설계 원칙

1. **모든 주문은 riskManager.check() 단일 관문 통과** — 수동이든 전략이든 예외 없음
2. 일일 손실 한도 도달 시 **킬스위치 자동 발동**
3. 프론트에는 앱키/시크릿 절대 미노출 — `API_AUTH_TOKEN`으로 백엔드 접근만 잠금
4. 실전 전환 순서: MOCK_DATA → KIS 모의투자 → (최소 수 주 검증) → 실전

## 스크립트

```json
"dev":   "tsx watch src/index.ts",
"build": "tsc",
"start": "node dist/index.js"
```
