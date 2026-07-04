import { Strategy, type StrategyContext } from "../engine.js";
import type { Quote } from "../../kis/types.js";

/**
 * OU 평균회귀 전략 — HJB 자유경계 기반.
 *
 * 모델:  로그가격 X가 Ornstein-Uhlenbeck 과정을 따른다고 가정
 *        dX = θ(μ - X)dt + σ dW
 *
 * 이론:  최적 진입/청산은 최적정지 문제이고, 가치함수는 HJB 변분부등식을 만족
 *        max{ ½σ²V'' + θ(μ-x)V' - rV,  g(x) - V(x) } = 0
 *        이 부등식의 자유경계가 곧 최적 매수경계 x*, 매도경계 x**.
 *
 * 구현:  1) 최근 가격열에서 (θ, μ, σ)를 AR(1) 회귀로 MLE 추정 (닫힌형)
 *        2) 변분부등식을 유한차분 + PSOR(투영 가우스-자이델)로 수치해
 *           - 청산문제: 장애물 g_sell(x) = e^x(1-fee)  → 매도경계 x**
 *           - 진입문제: 장애물 V(x) - e^x(1+fee)      → 매수경계 x*
 *        3) 현재가가 경계를 넘으면 주문 (기존 리스크 관문 통과)
 *
 * 가드:  - AR(1) 계수 b ∉ (0,1) → 평균회귀 아님 → 거래 중지
 *        - |b-1|/se(b) < 2      → 단위근 기각 실패(추세장 의심) → 거래 중지
 *        - 반감기 과대/과소     → 시간척도 안 맞음 → 거래 중지
 *        수학이 우아해도 가정이 깨지면 멈추는 것이 이 전략의 핵심 규율.
 */

interface OuParams {
  theta: number; // 회귀 속도 (per bar)
  mu: number; // 장기 평균 (로그가격)
  sigma: number; // 변동성 (per √bar)
  b: number; // AR(1) 계수 e^{-θΔ}
  seB: number; // b의 표준오차
  halfLifeBars: number;
}

interface Boundaries {
  buyLog: number; // x*  — 이하이면 매수
  sellLog: number; // x** — 이상이면 매도
}

export class OuMeanReversion extends Strategy {
  id = "ou-mean-reversion";
  name = "OU 평균회귀 (HJB)";

  /** 심볼별 가격 히스토리 (바 단위로 버킷팅) */
  private bars = new Map<string, number[]>();
  private lastBarAt = new Map<string, number>();
  private boundaries = new Map<string, Boundaries>();
  private lastFit = new Map<string, number>();
  private cooldown = new Map<string, number>();
  private holding = new Set<string>(); // 이 전략이 연 포지션 추적

  // ===== 하이퍼파라미터 =====
  private readonly BAR_MS = 30_000; // 30초 바
  private readonly MIN_BARS = 120; // 최소 표본 (1시간)
  private readonly MAX_BARS = 480; // 롤링 윈도우 (4시간)
  private readonly REFIT_MS = 5 * 60_000; // 5분마다 재추정
  private readonly FEE = 0.001; // 편도 수수료+슬리피지 가정 0.1%
  private readonly R = 1e-5; // 할인율 per bar (거의 0, 수치안정용)
  private readonly COOLDOWN_MS = 120_000;

  async onTick(q: Quote, ctx: StrategyContext) {
    this.pushBar(q.symbol, q.last);
    const bars = this.bars.get(q.symbol)!;
    if (bars.length < this.MIN_BARS) return;

    // ---- 주기적 재추정 + 경계 재계산 ----
    const lastFit = this.lastFit.get(q.symbol) ?? 0;
    if (Date.now() - lastFit > this.REFIT_MS) {
      this.lastFit.set(q.symbol, Date.now());
      const params = estimateOu(bars);
      const guard = this.checkGuards(params);
      if (guard) {
        this.boundaries.delete(q.symbol);
        ctx.log("WARN", `가드 발동 — 거래 중지: ${guard}`, {
          symbol: q.symbol,
          theta: round(params.theta, 4),
          b: round(params.b, 4),
          halfLifeBars: round(params.halfLifeBars, 1),
        });
        return;
      }
      const bounds = solveHjbBoundaries(params, this.FEE, this.R);
      this.boundaries.set(q.symbol, bounds);
      ctx.log("INFO", `OU 재추정 완료 — 경계 갱신`, {
        symbol: q.symbol,
        theta: round(params.theta, 4),
        mu_price: round(Math.exp(params.mu), 2),
        sigma: round(params.sigma, 5),
        halfLife_min: round((params.halfLifeBars * this.BAR_MS) / 60_000, 1),
        buyBelow: round(Math.exp(bounds.buyLog), 2),
        sellAbove: round(Math.exp(bounds.sellLog), 2),
      });
    }

    const bounds = this.boundaries.get(q.symbol);
    if (!bounds) return;

    // ---- 시그널 ----
    const x = Math.log(q.last);
    const lastOrder = this.cooldown.get(q.symbol) ?? 0;
    if (Date.now() - lastOrder < this.COOLDOWN_MS) return;

    if (x <= bounds.buyLog && !this.holding.has(q.symbol)) {
      const qty = Math.max(1, Math.floor(this.config.maxAmountPerSymbolUsd / q.ask));
      this.cooldown.set(q.symbol, Date.now());
      this.holding.add(q.symbol);
      ctx.log("INFO", `매수경계 도달: $${q.last} ≤ $${round(Math.exp(bounds.buyLog), 2)} → 매수`, {
        symbol: q.symbol,
      });
      await ctx.requestOrder({
        symbol: q.symbol,
        side: "buy",
        qty,
        price: q.ask,
        reason: `OU-HJB 매수경계 (x*=${round(Math.exp(bounds.buyLog), 2)})`,
      });
    } else if (x >= bounds.sellLog && this.holding.has(q.symbol)) {
      this.cooldown.set(q.symbol, Date.now());
      this.holding.delete(q.symbol);
      ctx.log("INFO", `매도경계 도달: $${q.last} ≥ $${round(Math.exp(bounds.sellLog), 2)} → 청산`, {
        symbol: q.symbol,
      });
      await ctx.requestOrder({
        symbol: q.symbol,
        side: "sell",
        qty: 0, // 0 = 전량
        price: q.bid,
        reason: `OU-HJB 매도경계 (x**=${round(Math.exp(bounds.sellLog), 2)})`,
      });
    }
  }

  private pushBar(symbol: string, price: number) {
    const now = Date.now();
    const last = this.lastBarAt.get(symbol) ?? 0;
    if (now - last < this.BAR_MS) {
      // 같은 바 안이면 마지막 값 갱신
      const arr = this.bars.get(symbol);
      if (arr && arr.length > 0) arr[arr.length - 1] = Math.log(price);
      return;
    }
    this.lastBarAt.set(symbol, now);
    const arr = this.bars.get(symbol) ?? [];
    arr.push(Math.log(price));
    if (arr.length > this.MAX_BARS) arr.shift();
    this.bars.set(symbol, arr);
  }

  private checkGuards(p: OuParams): string | null {
    if (!(p.b > 0 && p.b < 1)) return `AR(1) 계수 b=${round(p.b, 4)} — 평균회귀 아님`;
    const tStat = Math.abs(p.b - 1) / p.seB;
    if (tStat < 2) return `단위근 기각 실패 (|b-1|/se=${round(tStat, 2)} < 2) — 추세장 의심`;
    if (p.halfLifeBars < 4) return `반감기 ${round(p.halfLifeBars, 1)}바 — 노이즈 과적합 의심`;
    if (p.halfLifeBars > 240) return `반감기 ${round(p.halfLifeBars, 1)}바 — 회귀 너무 느림`;
    if (!(p.sigma > 0) || !isFinite(p.theta)) return "파라미터 발산";
    return null;
  }
}

// ===================== 수치부 =====================

/** AR(1) 회귀로 OU 파라미터 MLE (Δ=1 bar): X_{t+1} = a + b X_t + ε */
function estimateOu(x: number[]): OuParams {
  const n = x.length - 1;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += x[i + 1];
    sxx += x[i] * x[i];
    sxy += x[i] * x[i + 1];
  }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  // 잔차분산과 b의 표준오차
  let sse = 0;
  const meanX = sx / n;
  let ssxx = 0;
  for (let i = 0; i < n; i++) {
    const e = x[i + 1] - (a + b * x[i]);
    sse += e * e;
    ssxx += (x[i] - meanX) ** 2;
  }
  const varE = sse / (n - 2);
  const seB = Math.sqrt(varE / ssxx);

  const theta = -Math.log(Math.min(Math.max(b, 1e-8), 0.999999)); // per bar
  const mu = a / (1 - b);
  const sigma2 = (varE * 2 * theta) / (1 - b * b);
  return {
    theta,
    mu,
    sigma: Math.sqrt(Math.max(sigma2, 1e-12)),
    b,
    seB,
    halfLifeBars: Math.LN2 / theta,
  };
}

/**
 * HJB 변분부등식을 유한차분 + PSOR로 풀어 자유경계를 구한다.
 *
 * 연산자:  L V = ½σ²V'' + θ(μ-x)V' - rV   (드리프트는 upwind 차분 — 단조성 보장)
 *
 * 1) 청산문제:  max{LV, g_s - V} = 0,  g_s(x) = e^x(1-fee)
 *    → V가 장애물에 닿는 최소 x = 매도경계 x**
 * 2) 진입문제:  max{LJ, (V - g_b) - J} = 0,  g_b(x) = e^x(1+fee)
 *    → J가 장애물에 닿는 최대 x = 매수경계 x*
 */
function solveHjbBoundaries(p: OuParams, fee: number, r: number): Boundaries {
  const N = 400;
  const sigmaStat = p.sigma / Math.sqrt(2 * p.theta); // 정상분포 표준편차
  const xMin = p.mu - 4 * sigmaStat;
  const xMax = p.mu + 4 * sigmaStat;
  const h = (xMax - xMin) / (N - 1);
  const xs = Array.from({ length: N }, (_, i) => xMin + i * h);

  const s = 0.5 * p.sigma * p.sigma;

  // 계수 (upwind)
  const alpha = new Float64Array(N); // V_{i-1}
  const beta = new Float64Array(N); //  V_i
  const gamma = new Float64Array(N); // V_{i+1}
  for (let i = 1; i < N - 1; i++) {
    const drift = p.theta * (p.mu - xs[i]);
    const up = Math.max(drift, 0) / h;
    const dn = Math.max(-drift, 0) / h;
    alpha[i] = s / (h * h) + dn;
    gamma[i] = s / (h * h) + up;
    beta[i] = -(alpha[i] + gamma[i]) - r;
  }

  const psor = (obstacle: Float64Array): Float64Array => {
    const v = Float64Array.from(obstacle); // 초기값 = 장애물
    const omega = 1.5; // SOR 가속
    for (let iter = 0; iter < 8000; iter++) {
      let maxDiff = 0;
      for (let i = 1; i < N - 1; i++) {
        const gs = -(alpha[i] * v[i - 1] + gamma[i] * v[i + 1]) / beta[i];
        let nv = v[i] + omega * (gs - v[i]);
        if (nv < obstacle[i]) nv = obstacle[i]; // 투영
        const d = Math.abs(nv - v[i]);
        if (d > maxDiff) maxDiff = d;
        v[i] = nv;
      }
      // 경계: 장애물 고정 (그리드가 ±4σ라 실경계는 내부에 위치)
      v[0] = obstacle[0];
      v[N - 1] = obstacle[N - 1];
      if (maxDiff < 1e-9) break;
    }
    return v;
  };

  // 1) 청산문제
  const gSell = Float64Array.from(xs, (x) => Math.exp(x) * (1 - fee));
  const V = psor(gSell);
  let sellIdx = N - 1;
  for (let i = Math.floor(N / 2); i < N; i++) {
    if (V[i] - gSell[i] < 1e-7 * Math.max(1, gSell[i])) {
      sellIdx = i;
      break;
    }
  }

  // 2) 진입문제 (장애물 = V - 매수비용)
  const gBuy = Float64Array.from(xs, (x, i) => V[i] - Math.exp(x) * (1 + fee));
  const J = psor(gBuy);
  let buyIdx = 0;
  for (let i = Math.floor(N / 2); i >= 0; i--) {
    if (J[i] - gBuy[i] < 1e-7 * Math.max(1, Math.abs(gBuy[i]) + 1)) {
      buyIdx = i;
      break;
    }
  }

  return { buyLog: xs[buyIdx], sellLog: xs[sellIdx] };
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
