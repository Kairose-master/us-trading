# Railway 배포 — 백엔드 24/7 (페이퍼 장부 + 스캐너 자동 로테이션)

백엔드는 상시 실행 서버라 Vercel엔 못 올린다. Railway에 올리면
페이퍼 장부가 끊기지 않고 쌓이고, 24h 스캐너 자동 로테이션이 돈다.

레포에 이미 준비된 것: `backend/Dockerfile`(멀티스테이지, tsc→node dist),
`backend/railway.json`(헬스체크 `/health`, 실패 시 재시작),
`backend/package-lock.json`, CORS 오리진 env 화(`CORS_ORIGINS`).

## 단계 (약 5분, 전부 Railway 웹 UI)

1. https://railway.app → **New Project → Deploy from GitHub repo** →
   `Kairose-master/us-trading` 선택 (처음이면 GitHub 앱 설치 승인).
2. 생성된 서비스 → **Settings → Source → Root Directory**를 `backend`로.
   Dockerfile을 자동 감지해서 빌드한다.
3. **Settings → Volumes → Add Volume** → Mount path **`/app/data`**.
   ⚠️ 이거 없으면 재배포/재시작마다 페이퍼 장부가 초기화된다.
4. **Variables** 탭에 아래 입력:

   | 변수 | 값 | 왜 |
   |---|---|---|
   | `API_AUTH_TOKEN` | 긴 랜덤 문자열 (직접 생성) | API 인증. `dev-token` 기본값 그대로 두면 공개 API가 됨 |
   | `MOCK_DATA` | `true` | KIS 키 없이 미국주식 파트는 목으로 — 크립토는 어차피 항상 실데이터 |
   | `CRYPTO_SCANNER` | `true` | 24h 알트 스캐너 자동 로테이션 ON (페이퍼 전용) |
   | `CORS_ORIGINS` | `https://us-trading-dashboard.vercel.app,http://localhost:3000` | 대시보드에서 백엔드 호출 허용 |

   `PORT`는 Railway가 자동 주입 — 설정 불필요. `CRYPTO_TRADE`는 기본
   `true`(페이퍼)라 생략. **실주문 스위치(`CRYPTO_TRADE_ALLOW_REAL`,
   `AUTO_TRADE_ALLOW_REAL`)와 Upbit/KIS 키는 넣지 말 것** — 페이퍼
   기록으로 증명이 먼저다.
5. **Settings → Networking → Generate Domain** → 공개 URL 확보
   (예: `us-trading-backend-production.up.railway.app`).
6. 확인:
   ```bash
   curl https://<도메인>/health                       # {"ok":true}
   curl -H "Authorization: Bearer <토큰>" https://<도메인>/api/crypto/status
   ```
   `paperSince`가 찍히면 그 순간부터 라이브 페이퍼 기록 시작.

이후 main에 푸시할 때마다 Railway가 자동 재배포한다 (장부는 볼륨이라 유지).

## 알아둘 것

- **비용**: Railway는 무료 크레딧 소진 후 유료(Hobby $5/월 안팎). 이
  백엔드는 메모리 ~150MB급이라 최저 사양이면 충분.
- **대시보드 연동**: 현재 Vercel 대시보드의 홈/주문/포지션 화면은
  의도적으로 목 엔진이다 (`frontend/lib/api.ts`). Railway 백엔드가 떠도
  그 화면들이 자동으로 실데이터가 되진 않는다 — 실연동 배선은 별도
  작업. 크립토/스캐너/퀀트/랩 페이지는 브라우저가 업비트를 직접 불러서
  백엔드와 무관하게 이미 실데이터.
- **페이퍼 실적 확인**은 당분간 API로:
  `GET /api/crypto/status` (현재 장부) ·
  `GET /api/crypto/paper/equity` (시간당 에쿼티 커브) ·
  `GET /api/crypto/scanner` (최신 스캔/타깃).
- **MCP 워커로도 쓸 수 있다**: `POST https://<도메인>/mcp` — Vercel
  서버리스 워커와 달리 이쪽은 상시 파이프라인 상태를 담은 툴까지 서빙.
  Handsel에 붙일 땐 `MCP_AUTH_TOKEN`을 별도로 설정할 것.
