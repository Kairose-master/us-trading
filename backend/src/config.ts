import "dotenv/config";
import { z } from "zod";

/** 불리언 env — "true"/"1"/"yes"/"on"(대소문자 무관)을 참으로. Railway 대시보드에 1로 넣어도 켜진다 */
const asBool = (v: string) => /^(true|1|yes|on)$/i.test(v.trim());

const Env = z.object({
  KIS_APP_KEY: z.string().default(""),
  KIS_APP_SECRET: z.string().default(""),
  KIS_ACCOUNT_NO: z.string().default(""),
  KIS_MODE: z.enum(["mock", "real"]).default("mock"),
  PORT: z.coerce.number().default(4000),
  MOCK_DATA: z
    .string()
    .default("true")
    .transform(asBool),
  API_AUTH_TOKEN: z.string().default("dev-token"),
  // ===== 계정·금고 (docs/accounts.md) =====
  // 자격증명 금고(AES-256-GCM) 마스터 키 — 64자리 hex 권장 (openssl rand -hex 32). 없으면 금고 잠김.
  CREDENTIALS_MASTER_KEY: z.string().default(""),
  // "first"(기본) = 첫 사용자만 가입 가능(그가 owner), "true" = 누구나 가입
  SIGNUP_OPEN: z.string().default("first"),
  // 합성 뉴스 헤드라인 — 명시적 opt-in. 기본은 Google News RSS 실데이터 (키 불필요)
  NEWS_MOCK: z
    .string()
    .default("false")
    .transform(asBool),
  // 허용 CORS 오리진 (콤마 구분). 배포 시 대시보드 도메인을 추가할 것.
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  // ===== 자동매매 (전부 기본 OFF) =====
  AUTO_TRADE: z
    .string()
    .default("false")
    .transform(asBool),
  // 실모드(KIS real + 실데이터)에서 자동매매를 허용하는 명시적 이중 스위치
  AUTO_TRADE_ALLOW_REAL: z
    .string()
    .default("false")
    .transform(asBool),
  // ===== 크립토 (Upbit) =====
  // 시세/캔들은 키 없이 공개 API. 키는 계좌 조회/주문에만 필요.
  UPBIT_ACCESS_KEY: z.string().default(""),
  UPBIT_SECRET_KEY: z.string().default(""),
  // 크립토 신호 → 주문 기록. 기본 ON(페이퍼) — 라이브 기록을 쌓는 게 목적이고,
  // 실주문은 여전히 CRYPTO_TRADE_ALLOW_REAL + 키 없이는 불가능하다.
  CRYPTO_TRADE: z
    .string()
    .default("true")
    .transform(asBool),
  // 실제 Upbit 주문까지 허용하는 명시적 이중 스위치 (키 + 이 플래그 둘 다 필요)
  CRYPTO_TRADE_ALLOW_REAL: z
    .string()
    .default("false")
    .transform(asBool),
  // 알트코인 스캐너 자동 로테이션 (24h 주기, 페이퍼 장부 전용 — 실주문 경로 없음)
  CRYPTO_SCANNER: z
    .string()
    .default("true")
    .transform(asBool),
  // ===== 오피스 결정 루프 (Handsel 오피스 대화 → 결정 → 페이퍼 매매) =====
  // Handsel MCP 엔드포인트 — 기본 테스트넷(무가치 USDC). 메인넷(handsel-main)은
  // OFFICE_ALLOW_REAL_MONEY=true 없이는 escrow 거부.
  HANDSEL_MCP_URL: z.string().default("https://handsel-nu.vercel.app/api/mcp"),
  // 개인 MCP 토큰 (POST /api/oauth/personal-token 으로 발급, lmk_…)
  HANDSEL_MCP_TOKEN: z.string().default(""),
  // escrow를 내는 프라임 에이전트 id (비우면 Handsel이 첫 자금 있는 에이전트)
  HANDSEL_PRIME_AGENT_ID: z.string().default(""),
  // 오피스 역할들이 부를 우리 MCP 워커 (공개 HTTPS)
  OFFICE_WORKER_URL: z.string().default("https://us-trading-mcp-worker.vercel.app/api/mcp"),
  // 오피스 협의 모드 — local: 백엔드 안에서 9역할을 실도구로 직접 돌린다(에스크로 없음, 기본).
  // handsel: Handsel 오피스를 고용해 에스크로·독립 채점을 거친다 (HANDSEL_MCP_TOKEN 필요)
  OFFICE_MODE: z.enum(["local", "handsel"]).default("local"),
  OFFICE_SLOT: z.coerce.number().default(1),
  OFFICE_LOOP: z
    .string()
    .default("true")
    .transform(asBool),
  OFFICE_BUDGET_USD: z.coerce.number().default(10),
  OFFICE_INTERVAL_H: z.coerce.number().default(24),
  // ===== 진화 (PyGAD) — 페이퍼 개체군, 실캔들 시험 =====
  EVOLUTION: z.string().default("true").transform(asBool),
  // 제어 평면 자동조종 — 켜면 중재된 결정을 승인 없이 페이퍼 장부에 실행 (실주문은 별도 경계)
  // 부팅 시 오토파일럿 기본값 — 매 부팅마다 이 값으로 돌아간다. 운영자 토글은 그 부팅 동안만.
  // 지속적으로 멈추는 스위치는 따로 있다 (POST /control/pause — 상태 파일에 남고 재배포에도 유지)
  CONTROL_AUTOPILOT: z.string().default("true").transform(asBool),
  // 스케줄러 주기(분) — 보류된 결정을 사람 없이 집행하고, 만료된 제안을 치운다
  CONTROL_TICK_MIN: z.coerce.number().default(5),
  EVOLUTION_INTERVAL_H: z.coerce.number().default(6),
  // 세대마다 스쿼드 타깃을 제어 평면에 제안 (실행은 제어 평면이 정한다)
  EVOLUTION_PROPOSE: z.string().default("true").transform(asBool),
  OFFICE_ALLOW_REAL_MONEY: z
    .string()
    .default("false")
    .transform(asBool),
  // ===== MCP 워커 (Handsel office 탈부착용) =====
  // /mcp 엔드포인트 인증 토큰 — 비우면 API_AUTH_TOKEN을 그대로 쓴다
  MCP_AUTH_TOKEN: z.string().default(""),
  // true일 때만 MCP에 주문/자동매매 툴 노출 (기본: 읽기 전용 워커)
  MCP_TRADING: z
    .string()
    .default("false")
    .transform(asBool),
});

const env = Env.parse(process.env);

export const config = {
  ...env,
  kisBaseUrl:
    env.KIS_MODE === "real"
      ? "https://openapi.koreainvestment.com:9443"
      : "https://openapivts.koreainvestment.com:29443",
  kisWsUrl:
    env.KIS_MODE === "real"
      ? "ws://ops.koreainvestment.com:21000"
      : "ws://ops.koreainvestment.com:31000",
  // 계좌번호 분리 (KIS API는 CANO 8자리 + ACNT_PRDT_CD 2자리로 받음)
  get cano() {
    return env.KIS_ACCOUNT_NO.split("-")[0] ?? "";
  },
  get acntPrdtCd() {
    return env.KIS_ACCOUNT_NO.split("-")[1] ?? "01";
  },
  get corsOrigins() {
    return env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  },
  /** MCP 엔드포인트 인증 토큰 — 전용 토큰이 없으면 API 토큰 재사용 */
  get mcpAuthToken() {
    return env.MCP_AUTH_TOKEN || env.API_AUTH_TOKEN;
  },
};
