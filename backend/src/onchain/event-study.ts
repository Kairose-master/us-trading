/**
 * 이벤트 스터디 — 타임락이 "공표한" 시점부터 eta까지, 그 종목이 벤치마크(BTC 보유) 대비
 * 어땠는지를 잰다. 순수 함수.
 *
 * 룩어헤드가 없는 이유: 오늘의 owner·심각도 분류를 과거 가격에 적용하는 것과 다르다.
 * 여기서 쓰는 사실은 "그 블록 시각에 그 이벤트가 났다"는 것 하나뿐이고, 그 이벤트의
 * target·calldata·eta는 **그 순간 이미 온체인에 공개**돼 있었다. "공표 시점부터 eta까지
 * 보유했으면 벤치마크 대비 어땠나"는 그 정보가 나온 뒤의 실제 가격 변화를 재는 것이라
 * 미래 정보를 쓰지 않는다.
 *
 * 표본 단위는 **사건**이지 날짜가 아니다 — 같은 코인이 매일 나와도 사건이 하나면 관측 하나다.
 * 그래서 시계열 부트스트랩(quant/stats.ts의 backtestStats)이 아니라 사건 단위 재표집을 쓴다.
 */

export interface DisclosedEvent {
  market: string; // KRW-XXX
  key: string; // 타임락 키(사건 식별자)
  impact: string;
  announceIso: string;
  etaIso: string;
}

export interface PricedEvent extends DisclosedEvent {
  tokenReturnPct: number;
  benchReturnPct: number;
  spreadPct: number;
  days: number;
}

export type PriceLookup = (market: string, iso: string) => number | null;

/**
 * 사건마다 공표일 종가 → eta일 종가의 수익률을 토큰과 벤치마크 둘 다 잰다.
 * 가격이 없는 날은 그 사건을 버린다 (0으로 채우거나 지어내지 않는다).
 */
export function priceEvents(events: DisclosedEvent[], price: PriceLookup, benchMarket: string): PricedEvent[] {
  const out: PricedEvent[] = [];
  for (const e of events) {
    if (!(Date.parse(e.etaIso) > Date.parse(e.announceIso))) continue; // eta가 공표보다 앞서면 이상치 — 버린다
    const p0 = price(e.market, e.announceIso);
    const p1 = price(e.market, e.etaIso);
    const b0 = price(benchMarket, e.announceIso);
    const b1 = price(benchMarket, e.etaIso);
    if (!(p0! > 0) || !(p1! > 0) || !(b0! > 0) || !(b1! > 0)) continue;
    const tokenReturnPct = (p1! / p0! - 1) * 100;
    const benchReturnPct = (b1! / b0! - 1) * 100;
    const days = (Date.parse(e.etaIso) - Date.parse(e.announceIso)) / 86_400_000;
    out.push({ ...e, tokenReturnPct, benchReturnPct, spreadPct: +(tokenReturnPct - benchReturnPct).toFixed(3), days: +days.toFixed(1) });
  }
  return out;
}

export interface EventStudyResult {
  n: number;
  meanSpreadPct: number | null;
  medianSpreadPct: number | null;
  /** H0: 평균 스프레드 ≥ 0 (공표된 악재가 벤치마크 대비 손해를 주지 않는다) 에 대한 사건 단위 부트스트랩 p값 */
  bootstrapP: number | null;
  bootstrapIters: number;
  /** 표본이 이 아래면 p값을 신뢰하지 말라는 경고를 단다 — 숫자를 안 지우고 경고만 붙인다 */
  minReliableN: number;
  reliable: boolean;
  note: string;
}

const seeded = (seed: number) => { let s = seed >>> 0; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); };

/**
 * 사건 단위 부트스트랩. 시계열이 아니라 독립 사건 목록이라 블록 부트스트랩이 필요 없다 —
 * 스프레드 벡터를 통째로 복원추출한다.
 */
export function eventStudyStats(priced: PricedEvent[], opts: { iters?: number; seed?: number; minReliableN?: number } = {}): EventStudyResult {
  const iters = opts.iters ?? 5000;
  const minReliableN = opts.minReliableN ?? 20;
  const n = priced.length;
  if (n === 0) return { n: 0, meanSpreadPct: null, medianSpreadPct: null, bootstrapP: null, bootstrapIters: iters, minReliableN, reliable: false, note: "가격이 맞는 사건이 없다 — 잴 게 없다" };
  const spreads = priced.map((p) => p.spreadPct).sort((a, b) => a - b);
  const mean = spreads.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? spreads[(n - 1) / 2] : (spreads[n / 2 - 1] + spreads[n / 2]) / 2;
  const rand = seeded(opts.seed ?? 11);
  let geq = 0;
  for (let b = 0; b < iters; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += spreads[Math.floor(rand() * n)];
    if (sum / n >= 0) geq++;
  }
  const p = (geq + 1) / (iters + 1);
  const reliable = n >= minReliableN;
  const note = reliable
    ? `사건 ${n}개, 평균 스프레드 ${mean.toFixed(2)}%p, p=${p.toFixed(4)}`
    : `사건 ${n}개뿐이다 (권장 최소 ${minReliableN}) — p값을 계산은 했지만 결론을 내릴 표본이 아니다`;
  return { n, meanSpreadPct: +mean.toFixed(3), medianSpreadPct: +median.toFixed(3), bootstrapP: +p.toFixed(4), bootstrapIters: iters, minReliableN, reliable, note };
}
