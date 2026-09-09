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
   | `CRYPTO_SCANNER` | `true` | 알트 스캐너 유니버스 자동 갱신 |
   | `CORS_ORIGINS` | `https://us-trading-dashboard.vercel.app,http://localhost:3000` | 대시보드에서 백엔드 호출 허용 |

   `PORT`는 Railway가 자동 주입 — 설정 불필요. `CRYPTO_TRADE`는 기본
   `true`(페이퍼)라 생략. **`CRYPTO_TRADE_ALLOW_REAL`은 넣지 말 것** — 실주문은
   환경변수가 아니라 설정 페이지의 거래 모드 스위치로 켠다(아래 "실주문 켜기"). 페이퍼
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

## 허용 IP — Upbit 키를 넣을 때 (Railway Pro Static IP)

Upbit Open API 키는 발급 때 **허용 IP**를 반드시 등록해야 하고, 다른 IP에서
부르면 `no_authorization_ip`로 거부된다. Railway Hobby는 나가는 IP가 고정이
아니라(재배포 때 바뀔 수 있음) 등록해도 언젠가 깨진다. 고정 IP는 **Railway
Pro($20/월)의 Static Outbound IPs**로 만든다 — 추가 요금 없음, 서비스당 IP 3개가
로드밸런싱으로 배정된다.

1. Railway → 워크스페이스 **Settings → Plan → Pro**로 업그레이드.
2. 백엔드 서비스 → **Settings → Networking → Enable Static IPs** 토글. 켜면 그
   자리에 **IPv4 3개**가 표시된다 — 메모해 둘 것. (CLI:
   `railway outbound-network static-ip enable --service <서비스>` /
   `railway outbound-network status --service <서비스> --json`)
3. **재배포**(Deployments → Redeploy). 재배포 전엔 새 IP로 나가지 않는다.
4. 실제로 나가는 IP 확인 — 3개가 번갈아 나오므로 여러 번 샘플링:
   ```bash
   curl -H "Authorization: Bearer <토큰>" "https://<도메인>/api/system/egress?check=1&samples=8"
   # {"configured":false,"proxy":null,"targets":[],
   #  "direct":"<첫 샘플>","directSeen":["<IP1>","<IP2>","<IP3>"],"proxy":null}
   ```
   `directSeen`이 2단계에서 본 3개 안에 들어오면 정상.
5. Upbit → 마이페이지 → Open API 관리 → 키 발급/수정 → **허용 IP에 3개 전부**
   등록. 그 다음 `UPBIT_ACCESS_KEY`/`UPBIT_SECRET_KEY`를 Railway Variables 또는
   설정 페이지 금고에 넣는다.

주의: 서비스 **리전을 바꾸면 IP도 바뀐다**(Upbit 허용 IP 다시 등록). IP는 다른
Railway 고객과 공유될 수 있고 인바운드용이 아니다.

**Vercel(대시보드)에는 넣을 게 없다.** 프론트는 거래소를 직접 부르지 않고
`/api/backend/*` 프록시로 이 백엔드만 부른다. Vercel 변수는 기존대로
`BACKEND_TOKEN` 하나면 된다.

### 대안: 고정 IP HTTP 프록시 (Pro 안 쓸 때)

`EXCHANGE_PROXY_URL`(Fixie 등 `http://user:pw@host:port`)을 Railway Variables에
넣으면 백엔드가 Upbit **인증 호출(계좌/주문)만** 그 프록시로 보낸다
(`backend/src/core/egress.ts`). 공개 호출은 직접 나가 프록시 한도를 안 쓴다.
`EXCHANGE_PROXY_TARGETS`(기본 `upbit`)에 `kis`를 더하면 KIS도 경유하지만 KIS는
허용 IP가 없어 보통 불필요. 확인은 위와 같이 `/api/system/egress?check=1`의
`proxy` 값. 무료 티어(Fixie 월 500회)는 주문 빈도가 조금만 올라가도 소진되므로
주문이 자주 나가는 운영에서는 Pro Static IP가 맞다. 비워두면 동작은 기존과 같다.

## 실주문 켜기 (UI 스위치 — 환경변수 아님)

거래 모드는 `data/crypto-mode.json`(볼륨)에 남고 **설정 페이지**에서만 바뀐다.
`CRYPTO_TRADE_ALLOW_REAL`은 그 파일이 없을 때의 부팅 기본값일 뿐이라 Railway
Variables에 넣지 않는다.

1. 위 "허용 IP" 절대로 Static IP 3개를 Upbit 허용 IP에 등록 (키 권한: 자산조회 +
   주문만. **출금 OFF**).
2. Railway Variables에 `CREDENTIALS_MASTER_KEY`(`openssl rand -hex 32`)가 있어야
   금고가 열린다. 없으면 넣고 재배포.
3. 대시보드 → 로그인(첫 가입자가 owner) → **설정** → Upbit Open API 키를 금고에
   저장.
4. 설정 → **거래 모드** 카드 → "드라이런"으로 실계좌 기준 주문 계획을 먼저 본다
   (계좌 조회가 실패하면 키·허용 IP·권한 중 하나가 틀린 것 — 오류 문구에 Upbit 응답이
   그대로 나온다).
5. "실주문 모드로 전환" → `REAL` 타이핑 → 켜기. 이 순간 Upbit 계좌 조회가 성공해야
   모드가 바뀐다. 이후 제어 평면의 집행이 시장가 주문으로 나간다.
6. 처음엔 홈에서 **오토파일럿 OFF**로 두고 보류 결정을 직접 승인하며 며칠 관찰.
   주문당 상한은 데스크 `limits.maxOrderKrw`(기본 ₩500,000), 회전당 12건, 킬스위치
   (`POST /api/risk/killswitch`)가 켜지면 전면 차단. 되돌리기는 같은 카드의
   "PAPER로 돌아가기".

실모드에서는 `/api/crypto/status`의 현금·포지션·에쿼티가 실계좌(60초마다 동기화)
이고 에쿼티 커브는 `data/crypto-live-equity.jsonl`에 따로 쌓인다. 페이퍼 기록은
건드리지 않는다. 실주문 체결은 주문 목록에 `mode:"real"`, id는 Upbit uuid.

## 새 커밋이 배포되지 않을 때 (구 빌드가 계속 살아 있음)

Railway는 빌드가 실패하면 마지막 성공 배포를 그대로 둔다. `/health`는 200인데
새 라우트가 404면 이 경우다. Deployments 탭에서 최신 커밋이 **Failed**인지 확인.

- 2026-09-02: 루트 `.dockerignore`의 `**/data`가 소스 `backend/src/data/`까지
  빌드 컨텍스트에서 제외해 `tsc`가 실패 → 007bb17 이후 네 커밋이 전부 미배포.
  런타임 폴더만 제외하도록 `data`, `backend/data`로 좁혀 해결.
- 로컬 재현: `docker build .` (컨텍스트 필터까지 재현됨). `npm run build`만으로는
  `.dockerignore` 문제를 잡지 못한다.
