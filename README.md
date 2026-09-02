# us-trading

KIS 기반 미국주식 + Upbit 크립토 자동매매 워크스페이스 (backend Express + frontend Next.js + mcp-worker Vercel 서버리스).

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

## Handsel 연동

`docs/handsel-office.md` — 테스트넷/메인넷 에이전트 배선 기록, MCP 워커 주소,
그레이딩 결과.
