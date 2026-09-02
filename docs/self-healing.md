# 수집 감독자 — self-healing 데이터 파이프라인

외부 데이터 소스(Yahoo 시세, Upbit 시세·호가, Google News RSS ×2)는 각자의
`setInterval` 대신 `backend/src/core/supervisor.ts`에 등록되고 거기서 돈다.
릴(fidetolabs Day 12)의 "realtime monitor + self healing"을 화면만이 아니라 동작으로
옮긴 것이다. 화면의 모든 숫자·로그는 이 감독자의 실제 결정이다.

## 동작

| 상황 | 감독자 |
|---|---|
| 수집 성공 | `HEALTHY`, rows/s·lag 갱신 |
| 실패 1~2회 | `DEGRADED`, 지수 백오프 재시도 (1.5s → 3s → 6s …, ±20% 지터, 최대 30s) |
| 3회 연속 실패 | `FAILED` (계속 재시도) |
| 회복 | `recovered on retry N` 로그 → **백필**: 놓친 구간을 실제로 다시 받는다 |
| lag가 SLA를 넘겼다가 회복 | `healthy again — lag … back inside sla` |

백필은 소스가 replay 가능할 때만 한다.

- `upbit-tickers` — 장애 구간의 **1분봉**을 받아 종가를 틱으로 파이프라인에 재생 (호가 없음 → 사이즈 0, 로그에 명시)
- `news-rss-*` — 전 심볼 RSS를 다시 받아 **새 기사만** 흘림 (중복은 seen 집합이 거른다)
- `yahoo-quotes` — 지연 시세는 replay 불가 → "not replayable; resumed live"라고 적는다

## 조작 (owner 로그인 필요 — `docs/accounts.md`)

| 버튼 | 실제로 하는 일 |
|---|---|
| **BREAK NODE** | 선택한 소스에 N초 장애 주입. 그 소스의 `run()`이 **실제로 throw**하고, 감독자가 실제로 재시도·회복·백필한다. 로그에 `(operator action)`으로 남는다 |
| **HEAL ALL** | 주입 장애 해제 + 실패 중인 소스 즉시 재시도 |
| **PAUSE / RESUME** | 전 소스 정지/재개. 정지 중엔 아무것도 지어내지 않는다 |
| auto-recovery | 끄면 백오프 없이 다음 주기까지 그냥 기다린다 |

API: `GET /api/ops/supervisor[?market=]`, `GET /api/ops/supervisor/logs`,
`POST /api/ops/supervisor/{pause|resume|heal|auto-recovery}`, `POST /api/ops/supervisor/:id/break {seconds}`.
WS 채널 `ops`(스냅샷), `ops:log`(로그 한 줄).

## 검증 (2026-09-02, 로컬)

`upbit-tickers`에 70s 주입 → `FAILED — injected fault` → retry 1..6 (1.6s·2.5s·6.7s·11.8s·23.1s·56.4s)
→ `recovered on retry N — 5 rows live` → `healthy again — lag … outside sla 20s, back inside`
→ `backfill — replayed … rows since … · 1 minute candles × 5 markets replayed as ticks`.
회복이 백오프 상한(당시 60s)에 묶여 늦어져 상한을 30s로 내렸다.
