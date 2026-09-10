# 계정·자격증명 금고 — 보편 서비스로 가는 첫 단계

로그인한 사용자가 Upbit / KIS 키를 **서버에 암호화해 저장**하고, 거래 엔진이
환경변수 대신 그 금고에서 키를 꺼내 쓴다. 키는 브라우저에 남지 않고, 디스크에는
암호문만 있다.

## 구성

| 파일 | 역할 |
|---|---|
| `backend/src/auth/crypto.ts` | scrypt 비밀번호 해시 · AES-256-GCM 봉인/개봉 · 마스터 키 유도 |
| `backend/src/auth/store.ts` | `data/auth.json`(users, sessions) · `data/vault.json`(암호문) — 원자적 쓰기, 볼륨 영속 |
| `backend/src/auth/credentials.ts` | 엔진이 키를 찾는 순서: **환경변수 → owner 금고**. `upbit.ts`, `kis/auth.ts`, `kis/client.ts`가 여기서 읽는다 |
| `backend/src/auth/routes.ts` | `/api/auth/{config,register,login,logout,me}` · `/api/keys` · `PUT/DELETE /api/keys/{upbit,kis}` |
| `frontend/app/api/backend/[...path]/route.ts` | 세션 쿠키(httpOnly `hs_session`) → `X-Session` 헤더. 쓰기는 계정·금고 경로만 통과 |
| `frontend/app/login`, `frontend/app/settings` | 로그인/가입, 키 등록(끝 4자리만 표시)·삭제 |

## 보안 모델

- **마스터 키** — 설정 없이도 열린다. `CREDENTIALS_MASTER_KEY` 환경변수가 있으면 그것
  (64자리 hex면 그대로 32바이트, 아니면 scrypt 유도), 없으면 첫 기동 때 서버가 32바이트를
  생성해 `data/vault-master.key`(볼륨, 0600)에 저장하고 이후 재사용한다. 파일 방식은 키가
  암호문과 같은 볼륨에 있어 볼륨 유출 = 키 유출이다; 더 강하게 가려면 env로 분리한다.
  키 파일이 손상되면 금고는 잠기고 자동 재생성하지 않는다(기존 암호문 보호). 볼륨이 없으면
  재배포마다 키가 바뀌어 저장한 거래소 키를 못 연다 — `/app/data` 볼륨이 전제다.
  키를 바꾸면 기존 암호문은 못 연다 — 사용자가 다시 등록해야 한다.
- 레코드마다 새 IV, AAD = `userId:provider` → 다른 자리에 옮겨 붙인 암호문은 개봉 불가.
- 비밀번호는 scrypt(N=16384) 해시+솔트. 세션 토큰은 sha256만 디스크에 남고 30일 만료.
  로그인 시도는 IP당 10분 20회.
- 브라우저 JS는 세션 토큰을 못 본다(httpOnly). 프록시가 헤더로 옮긴다.
- 첫 가입자가 **owner**. `SIGNUP_OPEN=first`(기본)면 그 뒤 가입은 닫힌다; `true`면 열림.

## 지금의 한계 (다음 단계)

거래 엔진은 여전히 **하나**다 — Upbit 데스크·KIS 클라이언트·페이퍼 장부가 프로세스당
한 벌이고, owner의 키를 쓴다. 여러 사용자가 각자의 계좌로 매매하려면 사용자별
데스크 인스턴스(장부 파일 분리, 폴링 분리, 오피스 루프 분리)가 필요하다. 금고와
계정은 그 전제라서 먼저 넣었다.
