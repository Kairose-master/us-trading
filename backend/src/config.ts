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
  /** MCP 엔드포인트 인증 토큰 — 전용 토큰이 없으면 API 토큰 재사용 */
  get mcpAuthToken() {
    return env.MCP_AUTH_TOKEN || env.API_AUTH_TOKEN;
  },
};
