Notes between sessions working this repo at the same time. Read before touching anything; `node .claude/skills/parallel-repo-coordination/scripts/coordination-check.mjs --ack` after reading.
---

## 2026-09-02 14:27 · claude session 012nn9Ut (claude/trading-repo-video-impl-2o2wdz)

이 브랜치(claude/trading-repo-video-impl-2o2wdz)는 main과 항상 fast-forward 동기화된다. 지금 만지는 곳: backend/src/evolution/* (개체가 MCP 데스크를 빌리는 오피스 유전자), backend/src/control/plane.ts (통합 제어 평면), mcp-worker/api/mcp.ts (extractCoins를 Upbit KRW 전체로). Railway/Vercel은 main 푸시마다 자동 배포되니, main에 올리기 전에 backend tsc + frontend next build를 돌릴 것. 실주문 경로는 없다 — CRYPTO_TRADE_ALLOW_REAL 등 실돈 스위치는 켜지 마라.

## 2026-09-07 07:38 · jinu (codex/pipeline-quant-guards)

Pipeline changes on codex/pipeline-quant-guards: backend/src/pipeline/* and crypto desk replay metadata. Targets will be filtered before control-plane proposals; no live-money settings changed.

## 2026-09-09 04:24 · agent (claude/railway-deployment-ip-m01okr)

claude/railway-deployment-ip-m01okr: 거래소 고정 IP 프록시 추가 — backend/src/core/egress.ts(신규), upbit.ts 인증 호출(accounts/orders)만 egressFetch 경유, kis client/auth axios에 axiosEgress, config에 EXCHANGE_PROXY_URL/EXCHANGE_PROXY_TARGETS, routes에 GET /api/system/egress. 비우면 동작 동일(직접 호출). 실돈 스위치 안 건드림. deps: undici, https-proxy-agent.

## 2026-09-09 08:20 · agent (claude/railway-deployment-ip-m01okr)

claude/railway-deployment-ip-m01okr: 실주문 경로 추가 + 거래 모드 UI 스위치. backend/src/crypto/live.ts(신규, Upbit 실집행: 계획→매도→재동기화→매수, uuid 체결 확인), desk.ts(mode paper/real, data/crypto-mode.json 영속, rotateTo가 async가 됨 — 호출부는 await 필요, real이면 live로), upbit.ts(placeOrder는 armReal 없이는 차단, order(uuid) 추가), routes(GET/POST /crypto/mode owner 전용 confirm:'REAL', GET /crypto/live/preview 드라이런), auth/routes requireOwner, 프론트 설정 페이지 거래 모드 카드 + 프록시 허용. CRYPTO_TRADE_ALLOW_REAL은 부팅 기본값으로만 남음 — 환경변수로 실주문 못 켬. 기본은 여전히 paper. 스캐너/오피스/진화 파일은 안 건드림.

## 2026-09-10 00:20 · agent (claude/railway-deployment-ip-m01okr)

claude/railway-deployment-ip-m01okr: 금고 마스터 키 자동 생성 — CREDENTIALS_MASTER_KEY 없으면 backend/src/auth/crypto.ts가 첫 기동 때 data/vault-master.key(0600)를 만들어 쓴다. env가 있으면 그게 우선. 볼륨 없으면 재배포마다 키가 바뀌니 /app/data 볼륨 전제.

## 2026-09-10 00:34 · agent (claude/railway-deployment-ip-m01okr)

claude/railway-deployment-ip-m01okr: 프론트 크립토/미국주식 화면 분리 — /crypto = 크립토 데스크(모드 배지·계좌·제어 평면·보유·에쿼티), 알파 리서치는 /crypto/research 로 이동, / 와 /positions 는 미국주식(KIS) 전용, 사이드바 3그룹(크립토·미국주식·공통), 헤더는 크립토 경로에서 Upbit·거래모드 배지. 파이프라인·센티먼트는 ?market= 로 초기 시장. 백엔드 변경 없음.

## 2026-09-10 00:37 · agent (claude/railway-deployment-ip-m01okr)

claude/railway-deployment-ip-m01okr: 제어 평면 장부를 거래 모드별 파일로 분리 — plane.useMode(mode)가 data/control/state-live.json / benchmark-live.json 을 열고, 데스크 loadMode/setMode가 부른다. readState(file)는 null 반환 가능(호출부 fresh()). status()에 ledger:{mode,since} 추가.

## 2026-09-10 00:46 · agent (claude/railway-deployment-ip-m01okr)

claude/railway-deployment-ip-m01okr: 제어 평면에 기대 엣지 게이트 추가 — control/edge.ts(순수), plane.ts markTick이 시장별 드리프트(state.drift) 갱신, arbitrate가 회전 검사 뒤 edgeGate로 skipped 처리. 정책 필드 edgeGate/edgeZ/edgeHalfLifeMarks 추가(기본 true/1/72). Decision.edge, status.edge 추가. 프론트 command-center에 토글·표시.

## 2026-09-10 03:41 · agent (claude/railway-deployment-ip-m01okr)

claude/railway-deployment-ip-m01okr: council.ts 정족수 = min(2, 켜진 제안 매니저 수), 신호 단독 매수 금지는 다른 제안 매니저가 켜져 있을 때만. plane.setEngine이 참여 변경 시 보류 결정을 superseded로 버리고 즉시 재중재.
