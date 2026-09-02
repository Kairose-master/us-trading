# us-trading

KIS 기반 미국주식 + Upbit 크립토 자동매매 워크스페이스 (backend Express + frontend Next.js + mcp-worker Vercel 서버리스).

## 실데이터 원칙

화면의 모든 숫자는 실측이다. KIS 키가 없으면 미국주식 계좌/포지션/주문만
모의(백엔드 응답에 `mock: true`)이고, 시세(Yahoo Finance 지연)·뉴스(Google
News RSS)·크립토(Upbit)·파이프라인 지표는 전부 실데이터다. 배포된 대시보드는
`/api/backend/*` 읽기 전용 프록시로 Railway 백엔드를 부르며, 토큰이 없으면
"백엔드 미연결"을 그대로 보여준다 — 목 엔진으로 대체하지 않는다.

## 백테스트 비용 모델

모든 백테스트 경로(backend `/api/crypto/backtest`, `/api/ml/*`, `/api/quant/report`,
frontend `/crypto`·`/lab`·`/quant`의 브라우저 계산, Vercel MCP 워커의
`upbit_backtest_report`)는 **수수료 0.05% + 슬리피지 0.05%/편도**를 턴오버에
부과한다 (`DEFAULT_COSTS`, `backend/src/crypto/backtest.ts`). 종료 시점에 열린
포지션의 청산 비용도 차감하고, `costDragPct`(무비용 대비 비용이 갉아먹은 %p)를
지표로 노출한다. 비용 없는 숫자는 상한선일 뿐이라는 원칙.

## 페이퍼 모드

`CRYPTO_TRADE=true`가 기본값 — 크립토 데스크는 시작하자마자 **페이퍼 장부**로
라이브 기록을 쌓는다 (실주문은 여전히 `CRYPTO_TRADE_ALLOW_REAL=true` + Upbit 키
둘 다 없으면 불가능). 체결은 슬리피지 반영 가격 + 수수료 차감으로 기록되고,
상태는 `backend/data/crypto-paper.json`(현금/포지션/주문), 에쿼티 스냅샷은
`backend/data/crypto-paper-equity.jsonl`(시간당 1줄)에 저장되어 재시작을
견딘다. 조회: `GET /api/crypto/status`(paperSince 포함),
`GET /api/crypto/paper/equity`.

## 알트코인 스캐너

`/scanner` 페이지 + `GET /api/crypto/scanner` — 업비트 KRW 전 마켓(~287개) 중
24h 거래대금 상위 30개를 스캔해 **위험조정 모멘텀(mom20/vol20)** 으로 랭킹하고,
추세 필터(종가>MA20) 통과 + 양의 점수 상위 5개를 역변동성 가중(코인당 25% 상한)
으로 로테이션 타깃을 만든다. 자격 코인이 없으면 100% 현금이 정답이고 그대로
반환한다.

- `GET /api/crypto/scanner/backtest` — 같은 규칙의 주 1회 리밸런스 백테스트
  (비용 반영, BTC 보유·동일가중 벤치마크, 블록 부트스트랩 p-값 +
  **유니버스 크기만큼 Bonferroni 다중검정 보정**). 스캔 자체가 N번의 암묵적
  검정이라는 사실을 숫자로 노출한다.
- `POST /api/crypto/scanner/rotate` — 페이퍼 장부를 타깃 비중으로 로테이션.
  **페이퍼 전용** — 실주문 모드에서는 거부. `CRYPTO_SCANNER=true`면 24h마다
  자동 로테이션.

이 모드가 극대화하는 것은 "비용 차감 후 위험조정 기대수익"이라는 시도이지
수익 자체가 아니다 — 백테스트는 인샘플 상한선이고, 판단은 페이퍼 장부의
실기록이 한다.

## Handsel 연동

`docs/handsel-office.md` — 테스트넷/메인넷 에이전트 배선 기록, MCP 워커 주소,
그레이딩 결과.
