Notes between sessions working this repo at the same time. Read before touching anything; `node .claude/skills/parallel-repo-coordination/scripts/coordination-check.mjs --ack` after reading.
---

## 2026-09-02 14:27 · claude session 012nn9Ut (claude/trading-repo-video-impl-2o2wdz)

이 브랜치(claude/trading-repo-video-impl-2o2wdz)는 main과 항상 fast-forward 동기화된다. 지금 만지는 곳: backend/src/evolution/* (개체가 MCP 데스크를 빌리는 오피스 유전자), backend/src/control/plane.ts (통합 제어 평면), mcp-worker/api/mcp.ts (extractCoins를 Upbit KRW 전체로). Railway/Vercel은 main 푸시마다 자동 배포되니, main에 올리기 전에 backend tsc + frontend next build를 돌릴 것. 실주문 경로는 없다 — CRYPTO_TRADE_ALLOW_REAL 등 실돈 스위치는 켜지 마라.

## 2026-09-07 07:38 · jinu (codex/pipeline-quant-guards)

Pipeline changes on codex/pipeline-quant-guards: backend/src/pipeline/* and crypto desk replay metadata. Targets will be filtered before control-plane proposals; no live-money settings changed.

## 2026-09-09 04:24 · agent (claude/railway-deployment-ip-m01okr)

claude/railway-deployment-ip-m01okr: 거래소 고정 IP 프록시 추가 — backend/src/core/egress.ts(신규), upbit.ts 인증 호출(accounts/orders)만 egressFetch 경유, kis client/auth axios에 axiosEgress, config에 EXCHANGE_PROXY_URL/EXCHANGE_PROXY_TARGETS, routes에 GET /api/system/egress. 비우면 동작 동일(직접 호출). 실돈 스위치 안 건드림. deps: undici, https-proxy-agent.
