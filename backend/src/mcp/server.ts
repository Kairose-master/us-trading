import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../core/logger.js";
import { mcpTools } from "./tools.js";

/**
 * MCP 서버 (Streamable HTTP) — POST /mcp.
 *
 * Handsel office가 이 백엔드를 워커로 "탈부착"하는 접점이다:
 *   부착: wire_office_agent / connect_mcp_worker 에 server_url=https://<host>/mcp,
 *         tool_name=us_pipeline_report(등), auth_header="Bearer <MCP_AUTH_TOKEN>" 전달
 *   분리: 다른 커넥터로 rewire하거나 disconnect_mcp_worker — 서버 쪽에는 상태가 없다.
 *
 * Handsel의 lib/mcp-client.ts가 호출하는 슬라이스만 구현한다:
 *   initialize → notifications/initialized → tools/list → tools/call
 * 의존성 없이 손으로 만든 JSON-RPC 핸들러 (Handsel 자신의 /api/mcp도 같은 방식).
 */

const PROTOCOL_VERSION = "2025-06-18";

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function mcpAuthorized(req: Request): boolean {
  return req.headers.authorization === `Bearer ${config.mcpAuthToken}`;
}

export async function handleMcpRequest(req: Request, res: Response) {
  if (!mcpAuthorized(req)) {
    return res.status(401).json(rpcError(null, -32001, "unauthorized"));
  }

  const body = req.body as RpcRequest | RpcRequest[] | undefined;
  // 배치는 지원하지 않는다 — Handsel 클라이언트는 단건만 보낸다
  const msg: RpcRequest | undefined = Array.isArray(body) ? body[0] : body;
  if (!msg || typeof msg.method !== "string") {
    return res.status(400).json(rpcError(null, -32600, "invalid request"));
  }

  switch (msg.method) {
    case "initialize": {
      res.setHeader("Mcp-Session-Id", randomUUID());
      return res.json(
        rpcResult(msg.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: "us-trading-desk",
            version: "1.0.0",
            title: "US 오토트레이더 — KIS 미국주식 데스크",
          },
        }),
      );
    }

    case "notifications/initialized":
      return res.status(202).end();

    case "ping":
      return res.json(rpcResult(msg.id, {}));

    case "tools/list": {
      const tools = mcpTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      return res.json(rpcResult(msg.id, { tools }));
    }

    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = mcpTools().find((t) => t.name === params.name);
      if (!tool) return res.json(rpcError(msg.id, -32602, `unknown tool: ${params.name}`));
      const query = typeof params.arguments?.query === "string" ? params.arguments.query : "";
      try {
        const text = await tool.handler(query);
        logger.info("MCP tools/call", { tool: tool.name, queryChars: query.length });
        return res.json(rpcResult(msg.id, { content: [{ type: "text", text }], isError: false }));
      } catch (e) {
        logger.error("MCP 툴 실행 오류", { tool: tool.name, error: (e as Error).message });
        return res.json(
          rpcResult(msg.id, { content: [{ type: "text", text: `tool error: ${(e as Error).message}` }], isError: true }),
        );
      }
    }

    default:
      // 알 수 없는 notification은 조용히 수용, 요청이면 에러
      if (msg.id === undefined) return res.status(202).end();
      return res.json(rpcError(msg.id, -32601, `method not found: ${msg.method}`));
  }
}
