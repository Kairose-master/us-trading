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
3. **볼륨** — 서비스 설정에 "Volumes" 탭은 없다. 프로젝트 캔버스(서비스
   박스들이 보이는 화면) 우상단 **`+ Create`(또는 `+ New`) → Volume** →
   붙일 서비스로 `us-trading` 선택 → Mount path **`/app/data`**.
   (데스크톱은 캔버스 빈 곳 우클릭 → Volume, 또는 Cmd/Ctrl+K → "Volume".)
   붙으면 캔버스에 서비스 옆에 원통 아이콘이 생긴다.
   ⚠️ 이거 없으면 재배포/재시작마다 페이퍼 장부가 초기화된다 — 변수 저장
   때마다 재시작되므로 볼륨 없이는 `paperSince`가 계속 리셋된다.
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
- **대시보드 연동 (Vercel)**: 대시보드는 `/api/backend/*` 읽기 전용
  프록시(Next 라우트 핸들러)로 이 백엔드를 부른다. 토큰은 서버 env에만.
  Vercel 프로젝트 → Settings → Environment Variables에
  **`BACKEND_TOKEN`** = Railway의 `API_AUTH_TOKEN` 값 하나만 넣고
  Redeploy. (`BACKEND_URL`은 Railway 주소가 기본값이라 생략 가능.)
  토큰이 없으면 화면은 "백엔드 미연결"을 그대로 보여준다 — 목데이터로
  대체하지 않는다. 쓰기(주문·자동매매 토글·킬스위치)는 공개 대시보드에서
  막혀 있고 백엔드 API에 직접 토큰으로만 가능하다.
- **KIS 키 없이도 미국주식 파이프라인은 실데이터**: `MOCK_DATA=true`는
  이제 "계좌/포지션/주문만 모의"라는 뜻이고, 시세는 Yahoo Finance(지연,
  호가 없음), 뉴스는 Google News RSS 실데이터다. 랜덤워크 틱·합성
  헤드라인은 `NEWS_MOCK=true`로 명시하지 않는 한 나오지 않는다.
- **페이퍼 실적 확인**은 당분간 API로:
  `GET /api/crypto/status` (현재 장부) ·
  `GET /api/crypto/paper/equity` (시간당 에쿼티 커브) ·
  `GET /api/crypto/scanner` (최신 스캔/타깃).
- **MCP 워커로도 쓸 수 있다**: `POST https://<도메인>/mcp` — Vercel
  서버리스 워커와 달리 이쪽은 상시 파이프라인 상태를 담은 툴까지 서빙.
  Handsel에 붙일 땐 `MCP_AUTH_TOKEN`을 별도로 설정할 것.

## 새 커밋이 배포되지 않을 때 (구 빌드가 계속 살아 있음)

Railway는 빌드가 실패하면 마지막 성공 배포를 그대로 둔다. `/health`는 200인데
새 라우트가 404면 이 경우다. Deployments 탭에서 최신 커밋이 **Failed**인지 확인.

- 2026-09-02: 루트 `.dockerignore`의 `**/data`가 소스 `backend/src/data/`까지
  빌드 컨텍스트에서 제외해 `tsc`가 실패 → 007bb17 이후 네 커밋이 전부 미배포.
  런타임 폴더만 제외하도록 `data`, `backend/data`로 좁혀 해결.
- 로컬 재현: `docker build .` (컨텍스트 필터까지 재현됨). `npm run build`만으로는
  `.dockerignore` 문제를 잡지 못한다.
