import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciInit } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";

/**
 * 거래소 아웃바운드 고정 IP 프록시 (docs/deploy-railway.md "허용 IP").
 *
 * Railway Hobby는 나가는 IP가 고정이 아니라 Upbit처럼 허용 IP를 강제하는 API에
 * 키를 등록할 수 없다. EXCHANGE_PROXY_URL(Fixie 등 고정 IP HTTP 프록시)을 주면
 * 여기 지정된 대상(기본 upbit)의 **인증 호출만** 프록시를 거친다 — 시세/캔들
 * 같은 공개 호출은 여전히 직접 나가서 무료 티어 월 500회 한도를 아낀다.
 *
 * 프록시 URL은 자격증명을 담고 있으므로 status에는 host만 노출한다.
 */

export type EgressTarget = "upbit" | "kis";

const TARGETS = new Set<EgressTarget>(["upbit", "kis"]);

export function parseTargets(raw: string): EgressTarget[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is EgressTarget => TARGETS.has(s as EgressTarget));
}

export function proxyUrlFor(target: EgressTarget, env: { url: string; targets: string } = { url: config.EXCHANGE_PROXY_URL, targets: config.EXCHANGE_PROXY_TARGETS }): string | null {
  const url = env.url.trim();
  if (!url) return null;
  return parseTargets(env.targets).includes(target) ? url : null;
}

/** 자격증명 제거 — 로그/상태 응답용 */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(invalid url)";
  }
}

const agents = new Map<string, ProxyAgent>();
function dispatcherFor(url: string): ProxyAgent {
  let a = agents.get(url);
  if (!a) {
    a = new ProxyAgent(url);
    agents.set(url, a);
  }
  return a;
}

/** fetch — 대상이 프록시 대상이면 ProxyAgent 경유, 아니면 그대로 global fetch */
export function egressFetch(target: EgressTarget, url: string, init?: RequestInit): Promise<Response> {
  const proxy = proxyUrlFor(target);
  if (!proxy) return fetch(url, init);
  return undiciFetch(url, { ...(init as UndiciInit), dispatcher: dispatcherFor(proxy) }) as unknown as Promise<Response>;
}

/** axios 옵션 — 대상이 프록시 대상이면 httpsAgent(CONNECT 터널) + axios 내장 proxy OFF */
export function axiosEgress(target: EgressTarget): { httpsAgent?: HttpsProxyAgent<string>; proxy?: false } {
  const proxy = proxyUrlFor(target);
  if (!proxy) return {};
  return { httpsAgent: new HttpsProxyAgent(proxy), proxy: false };
}

export function egressStatus() {
  const url = config.EXCHANGE_PROXY_URL.trim();
  return {
    configured: Boolean(url),
    proxy: url ? redactProxyUrl(url) : null,
    targets: url ? parseTargets(config.EXCHANGE_PROXY_TARGETS) : [],
  };
}

const IP_ECHO = "https://api.ipify.org?format=json";

async function echoIp(viaProxy: string | null): Promise<string> {
  const init = { signal: AbortSignal.timeout(10_000) };
  const res = viaProxy
    ? await undiciFetch(IP_ECHO, { ...init, dispatcher: dispatcherFor(viaProxy) })
    : await fetch(IP_ECHO, init);
  if (!res.ok) throw new Error(`ip echo → HTTP ${res.status}`);
  return ((await res.json()) as { ip: string }).ip;
}

/**
 * 실제로 나가는 IP 확인 — direct는 컨테이너가 직접 나갈 때의 IP(Railway Static IP를
 * 켰으면 3개 중 하나가 로드밸런싱으로 잡히므로 몇 번 샘플링해 전부 모은다),
 * proxy는 EXCHANGE_PROXY_URL을 거친 IP. 거래소 허용 IP에는 directSeen 전부
 * (프록시를 쓸 땐 proxy)를 등록한다. 프록시가 있으면 프록시 요청 1회를 소모한다.
 */
export async function egressCheck(samples = 3): Promise<{ direct: string | null; directSeen: string[]; proxy: string | null; error?: string }> {
  const out: { direct: string | null; directSeen: string[]; proxy: string | null; error?: string } = { direct: null, directSeen: [], proxy: null };
  const errs: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(1, samples); i++) {
    try { seen.add(await echoIp(null)); } catch (e) { if (i === 0) errs.push(`direct: ${(e as Error).message}`); }
  }
  out.directSeen = [...seen];
  out.direct = out.directSeen[0] ?? null;
  const url = config.EXCHANGE_PROXY_URL.trim();
  if (url) {
    try { out.proxy = await echoIp(url); } catch (e) { errs.push(`proxy: ${(e as Error).message}`); }
  }
  if (errs.length) out.error = errs.join(" · ");
  return out;
}
