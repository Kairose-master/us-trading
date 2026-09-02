import { config } from "../config.js";
import { authStore } from "./store.js";

/**
 * 거래 엔진이 키를 찾는 순서: 환경변수 → owner 계정의 금고. 둘 다 없으면 null.
 * 데스크는 여전히 하나(단일 엔진)라 owner의 키를 쓴다. 사용자별 데스크는 다음 단계.
 */
export function upbitKeys(): { accessKey: string; secretKey: string } | null {
  if (config.UPBIT_ACCESS_KEY && config.UPBIT_SECRET_KEY) return { accessKey: config.UPBIT_ACCESS_KEY, secretKey: config.UPBIT_SECRET_KEY };
  const o = authStore.owner();
  const k = o ? authStore.keys(o.id, "upbit") : null;
  return k?.accessKey && k?.secretKey ? { accessKey: k.accessKey, secretKey: k.secretKey } : null;
}

export function kisKeys(): { appKey: string; appSecret: string; accountNo: string } | null {
  if (config.KIS_APP_KEY && config.KIS_APP_SECRET) return { appKey: config.KIS_APP_KEY, appSecret: config.KIS_APP_SECRET, accountNo: config.KIS_ACCOUNT_NO };
  const o = authStore.owner();
  const k = o ? authStore.keys(o.id, "kis") : null;
  return k?.appKey && k?.appSecret ? { appKey: k.appKey, appSecret: k.appSecret, accountNo: k.accountNo ?? "" } : null;
}

export function credentialSources() {
  const o = authStore.owner();
  return {
    vaultUnlocked: authStore.vaultUnlocked(),
    owner: o?.email ?? null,
    upbit: config.UPBIT_ACCESS_KEY ? "env" : o && authStore.keys(o.id, "upbit") ? "vault" : null,
    kis: config.KIS_APP_KEY ? "env" : o && authStore.keys(o.id, "kis") ? "vault" : null,
  };
}
