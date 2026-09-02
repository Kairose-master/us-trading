/**
 * 레포 루트에서 Vercel이 빌드해도 MCP 워커가 살아있게 하는 재수출.
 * us-trading-mcp-worker 프로젝트가 GitHub에 연결된 채 Root Directory가
 * 비어 있으면 루트에서 빌드되는데, 그때 api/mcp.ts가 없으면 빈 배포가
 * 프로덕션을 덮어써 /api/mcp가 404가 된다 (실제로 한 번 발생). 구현은
 * mcp-worker/api/mcp.ts 하나뿐이고 여기는 그걸 가리키기만 한다.
 */
export { default } from "../mcp-worker/api/mcp";
