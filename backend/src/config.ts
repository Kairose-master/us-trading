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
};
