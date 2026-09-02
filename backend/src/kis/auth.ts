import axios from "axios";
import { config } from "../config.js";
import { kisKeys } from "../auth/credentials.js";
import { KIS } from "./endpoints.js";
import { logger } from "../core/logger.js";

/**
 * KIS 접근토큰 관리자.
 * - 토큰은 발급 후 24시간 유효, KIS는 재발급을 1분당 1회로 제한하므로
 *   반드시 캐싱하고 만료 임박 시에만 갱신한다.
 */
class TokenManager {
  private token: string | null = null;
  private expiresAt = 0; // epoch ms
  private refreshing: Promise<string> | null = null;

  get expiresAtIso(): string {
    return this.expiresAt ? new Date(this.expiresAt).toISOString() : "";
  }

  async get(): Promise<string> {
    const SAFETY_MS = 10 * 60 * 1000; // 만료 10분 전부터 갱신
    if (this.token && Date.now() < this.expiresAt - SAFETY_MS) return this.token;
    if (this.refreshing) return this.refreshing;

    this.refreshing = this.issue().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async issue(): Promise<string> {
    const res = await axios.post(`${config.kisBaseUrl}${KIS.token.path}`, {
      grant_type: "client_credentials",
      appkey: (kisKeys()?.appKey ?? ""),
      appsecret: (kisKeys()?.appSecret ?? ""),
    });
    this.token = res.data.access_token as string;
    // expires_in은 초 단위
    this.expiresAt = Date.now() + Number(res.data.expires_in ?? 86400) * 1000;
    logger.info("KIS access token issued", { expiresAt: this.expiresAtIso });
    return this.token;
  }

  /** WebSocket 접속용 approval_key 발급 */
  async getWsApprovalKey(): Promise<string> {
    const res = await axios.post(`${config.kisBaseUrl}${KIS.wsApprovalKey.path}`, {
      grant_type: "client_credentials",
      appkey: (kisKeys()?.appKey ?? ""),
      secretkey: (kisKeys()?.appSecret ?? ""), // 주의: 이 엔드포인트만 'secretkey' 키를 씀
    });
    return res.data.approval_key as string;
  }
}

export const tokenManager = new TokenManager();
