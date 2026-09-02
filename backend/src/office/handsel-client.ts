import { config } from "../config.js";

/**
 * Handsel MCP 클라이언트 — 백엔드가 오피스를 "고용"하고 산출물을 받아오는 접점.
 * Streamable HTTP(무상태 JSON-RPC) + 개인 토큰(lmk_…, /api/oauth/personal-token).
 * 여기서 돈이 움직이는 호출은 confirmDelegation 하나뿐이고, 그것도
 * HANDSEL_MCP_URL이 가리키는 배포(기본: 테스트넷)의 USDC다.
 * 메인넷 URL은 OFFICE_ALLOW_REAL_MONEY=true 없이는 거부한다.
 */

const TIMEOUT_MS = 110_000;

export interface HandselConnector {
  role_id: string;
  server_url: string;
  tool_name: string;
  mode: "assisted" | "proxy";
  label?: string;
}

export class HandselClient {
  readonly url: string;
  private readonly token: string;
  private seq = 0;

  constructor(url = config.HANDSEL_MCP_URL, token = config.HANDSEL_MCP_TOKEN) {
    this.url = url;
    this.token = token;
  }

  configured(): boolean {
    return Boolean(this.token);
  }

  isRealMoney(): boolean {
    return /handsel-main/.test(this.url);
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.token) throw new Error("HANDSEL_MCP_TOKEN 미설정 — /api/oauth/personal-token 으로 발급해 넣을 것");
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.seq, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Handsel MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
    if (body.error) throw new Error(`Handsel MCP ${body.error.code}: ${body.error.message}`);
    return body.result;
  }

  /** tools/call → 텍스트 콘텐츠를 합쳐 돌려준다 (Handsel 툴은 전부 텍스트를 낸다) */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new Error(`Handsel ${name} 실패: ${text.slice(0, 300)}`);
    return text;
  }

  hireOffice(p: { templateId: string; scope: string; budgetUsd: number; office: number; primeAgentId?: string; connectors: HandselConnector[] }) {
    return this.call("hire_office", {
      template_id: p.templateId,
      scope: p.scope,
      budget_usd: p.budgetUsd,
      office: p.office,
      ...(p.primeAgentId ? { prime_agent_id: p.primeAgentId } : {}),
      connectors: p.connectors,
    });
  }

  confirmDelegation(delegationId: string) {
    if (this.isRealMoney() && !config.OFFICE_ALLOW_REAL_MONEY) {
      throw new Error("메인넷 Handsel에 escrow 거부 — OFFICE_ALLOW_REAL_MONEY=true 없이는 실돈을 걸지 않는다");
    }
    return this.call("confirm_delegation", { delegation_id: delegationId });
  }

  delegationStatus() {
    return this.call("delegation_status", {});
  }

  getDelegationOutput(delegationId: string) {
    return this.call("get_delegation_output", { delegation_id: delegationId });
  }
}

export const handsel = new HandselClient();
