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
  api/
    routes.ts         # 프론트 스펙 그대로의 REST
    wsRelay.ts        # /ws/live — 프론트용 릴레이
    state.ts          # 인메모리 상태 + 목 시뮬레이터
```

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
