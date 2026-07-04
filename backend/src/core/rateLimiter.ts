/**
 * 토큰버킷 레이트리미터.
 * KIS는 계정당 초당 호출 제한(신규 고객 기준 강화됨)이 있으므로
 * 모든 REST 호출은 이 리미터를 통과시킨다. 큐잉 방식이라 429를 예방한다.
 */
export class RateLimiter {
  private tokens: number;
  private queue: (() => void)[] = [];
  private windowCalls: number[] = []; // 사용률 표시용

  constructor(
    private ratePerSec: number,
    private burst: number = ratePerSec
  ) {
    this.tokens = burst;
    setInterval(() => {
      this.tokens = Math.min(this.burst, this.tokens + this.ratePerSec);
      this.drain();
    }, 1000).unref();
  }

  private drain() {
    while (this.tokens >= 1 && this.queue.length > 0) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
  }

  acquire(): Promise<void> {
    this.windowCalls.push(Date.now());
    this.windowCalls = this.windowCalls.filter((t) => Date.now() - t < 10_000);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise((res) => this.queue.push(res));
  }

  /** 최근 10초 사용률 (%) — 프론트 게이지용 */
  usagePct(): number {
    const capacity = this.ratePerSec * 10;
    return Math.min(100, Math.round((this.windowCalls.length / capacity) * 100));
  }
}
