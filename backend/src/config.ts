import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  KIS_APP_KEY: z.string().default(""),
  KIS_APP_SECRET: z.string().default(""),
  KIS_ACCOUNT_NO: z.string().default(""),
  KIS_MODE: z.enum(["mock", "real"]).default("mock"),
  PORT: z.coerce.number().default(4000),
  MOCK_DATA: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  API_AUTH_TOKEN: z.string().default("dev-token"),
  // 허용 CORS 오리진 (콤마 구분). 배포 시 대시보드 도메인을 추가할 것.
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  // ===== 자동매매 (전부 기본 OFF) =====
  AUTO_TRADE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // 실모드(KIS real + 실데이터)에서 자동매매를 허용하는 명시적 이중 스위치
  AUTO_TRADE_ALLOW_REAL: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // ===== 크립토 (Upbit) =====
  // 시세/캔들은 키 없이 공개 API. 키는 계좌 조회/주문에만 필요.
  UPBIT_ACCESS_KEY: z.string().default(""),
  UPBIT_SECRET_KEY: z.string().default(""),
  // 크립토 신호 → 주문 기록. 기본 ON(페이퍼) — 라이브 기록을 쌓는 게 목적이고,
  // 실주문은 여전히 CRYPTO_TRADE_ALLOW_REAL + 키 없이는 불가능하다.
  CRYPTO_TRADE: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  // 실제 Upbit 주문까지 허용하는 명시적 이중 스위치 (키 + 이 플래그 둘 다 필요)
  CRYPTO_TRADE_ALLOW_REAL: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // 알트코인 스캐너 자동 로테이션 (24h 주기, 페이퍼 장부 전용 — 실주문 경로 없음)
  CRYPTO_SCANNER: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // ===== MCP 워커 (Handsel office 탈부착용) =====
  // /mcp 엔드포인트 인증 토큰 — 비우면 API_AUTH_TOKEN을 그대로 쓴다
  MCP_AUTH_TOKEN: z.string().default(""),
  // true일 때만 MCP에 주문/자동매매 툴 노출 (기본: 읽기 전용 워커)
  MCP_TRADING: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
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
