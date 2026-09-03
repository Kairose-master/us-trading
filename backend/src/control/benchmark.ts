/**
 * 벤치마크 — "우리 결정이 뭔가를 더했나"를 답하는 유일한 줄.
 *
 * 장부 초기화 시점을 기준(base)으로 셋을 나란히 둔다:
 *   portfolio  실제 페이퍼 장부 에쿼티 (비용 포함)
 *   btcHold    같은 시점에 BTC를 사서 들고만 있었다면
 *   ewUniverse 같은 시점의 투자 유니버스를 동일비중으로 사서 들고만 있었다면 (기준 시점 바스켓 고정 — lookahead 없음)
 *
 * 초과(alpha) = portfolio − 벤치마크. 이 숫자가 0 근처거나 음수면 협의회·진화·오피스는 비용만 낸 것이다.
 * 순수 함수만 둔다. 가격·파일 I/O는 benchmark-store가 한다.
 */

export interface BenchmarkBase {
  /** 기준 시점 (장부 초기화 시각) */
  since: string;
  startEquityKrw: number;
  /** 기준 시점의 BTC 가격 (없으면 null — BTC 벤치마크 계산 불가) */
  btcKrw: number | null;
  /** 기준 시점의 유니버스 바스켓: 시장 → 기준 가격 */
  basket: Record<string, number>;
  /** 기준 가격의 출처 — 초기화 순간의 실시세인지, 부팅 시 분봉으로 복원한 것인지 */
  source: "live" | "minute-candle" | "unknown";
}

export interface BenchmarkRead {
  since: string;
  source: BenchmarkBase["source"];
  hours: number;
  portfolioPct: number;
  btcHoldPct: number | null;
  ewUniversePct: number | null;
  /** 동일비중 바스켓에서 현재가를 가진 종목 수 / 바스켓 크기 */
  ewCoverage: { priced: number; basket: number };
  alphaVsBtcPct: number | null;
  alphaVsEwPct: number | null;
}

const pct = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : 0);

export function computeBenchmark(base: BenchmarkBase, prices: Record<string, number>, equityKrw: number, now = Date.now()): BenchmarkRead {
  const portfolioPct = pct(equityKrw, base.startEquityKrw);
  const btcNow = prices["KRW-BTC"];
  const btcHoldPct = base.btcKrw && btcNow > 0 ? pct(btcNow, base.btcKrw) : null;
  const members = Object.entries(base.basket).filter(([, p0]) => p0 > 0);
  let sum = 0, priced = 0;
  for (const [m, p0] of members) { const p1 = prices[m]; if (p1 > 0) { sum += p1 / p0 - 1; priced++; } }
  // 현재가가 없는 종목(상장폐지·유니버스 이탈)은 바스켓에서 빼고 평균한다 — 커버리지가 절반 아래면 숫자를 내지 않는다
  const ewUniversePct = members.length && priced >= Math.ceil(members.length / 2) ? (sum / priced) * 100 : null;
  const r = (x: number | null) => (x === null ? null : +x.toFixed(3));
  return {
    since: base.since,
    source: base.source,
    hours: +((now - Date.parse(base.since)) / 3_600_000).toFixed(2),
    portfolioPct: +portfolioPct.toFixed(3),
    btcHoldPct: r(btcHoldPct),
    ewUniversePct: r(ewUniversePct),
    ewCoverage: { priced, basket: members.length },
    alphaVsBtcPct: btcHoldPct === null ? null : +(portfolioPct - btcHoldPct).toFixed(3),
    alphaVsEwPct: ewUniversePct === null ? null : +(portfolioPct - ewUniversePct).toFixed(3),
  };
}

/** 기준 만들기 — 바스켓은 기준 시점의 유니버스, 가격이 없는 종목은 바스켓에 넣지 않는다 */
export function makeBase(p: { since: string; startEquityKrw: number; markets: string[]; prices: Record<string, number>; source: BenchmarkBase["source"] }): BenchmarkBase {
  const basket: Record<string, number> = {};
  for (const m of p.markets) if (p.prices[m] > 0) basket[m] = p.prices[m];
  return { since: p.since, startEquityKrw: p.startEquityKrw, btcKrw: p.prices["KRW-BTC"] > 0 ? p.prices["KRW-BTC"] : null, basket, source: p.source };
}
