/**
 * 사전(lexicon) 기반 금융 뉴스 감성 스코어러.
 * LLM 없이 결정적으로 동작한다 — 키가 없어도 파이프라인의 비정형 레인이 실제로 계산된다.
 * 점수는 [-1, 1]. 부정어(negation)가 3토큰 안에 있으면 극성 반전.
 */

const POSITIVE: Record<string, number> = {
  beat: 2, beats: 2, surge: 2, surges: 2, soar: 2, soars: 2, rally: 2, rallies: 2,
  record: 1, upgrade: 2, upgraded: 2, outperform: 2, bullish: 2, buy: 1,
  growth: 1, grows: 1, strong: 1, stronger: 1, gain: 1, gains: 1, jump: 2, jumps: 2,
  rise: 1, rises: 1, up: 1, high: 1, profit: 1, profits: 1, raise: 1, raises: 1, raised: 1,
  breakthrough: 2, wins: 1, win: 1, approval: 1, approved: 1, partnership: 1, expands: 1,
  optimistic: 1, momentum: 1, demand: 1, tops: 2, exceeds: 2, accelerates: 1, boom: 2,
};

const NEGATIVE: Record<string, number> = {
  miss: 2, misses: 2, plunge: 2, plunges: 2, plummet: 2, plummets: 2, crash: 2, crashes: 2,
  downgrade: 2, downgraded: 2, bearish: 2, sell: 1, selloff: 2, weak: 1, weaker: 1,
  fall: 1, falls: 1, drop: 1, drops: 1, drops_: 1, down: 1, low: 1, loss: 1, losses: 1,
  cut: 1, cuts: 1, layoff: 2, layoffs: 2, lawsuit: 2, probe: 2, investigation: 2,
  recall: 2, fine: 1, fined: 2, warning: 1, warns: 1, delay: 1, delays: 1, delayed: 1,
  concern: 1, concerns: 1, risk: 1, risks: 1, slump: 2, slumps: 2, halt: 1, halted: 1,
  fraud: 2, breach: 2, tumbles: 2, tumble: 2, sinks: 2, sink: 2, misses_: 2, slides: 1,
};

const NEGATORS = new Set(["not", "no", "never", "without", "fails", "fail", "isn't", "won't", "don't", "doesn't"]);
const INTENSIFIERS: Record<string, number> = { very: 1.3, sharply: 1.5, massive: 1.5, huge: 1.4, slightly: 0.6, modestly: 0.7 };

export interface HeadlineScore {
  score: number; // [-1, 1]
  /** |누적 가중치| 기반 신뢰도 [0, 1] */
  confidence: number;
  /** 점수에 기여한 단어들 */
  hits: string[];
}

export function scoreHeadline(text: string): HeadlineScore {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s%-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  let raw = 0;
  let weightAbs = 0;
  const hits: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let w = 0;
    if (t in POSITIVE) w = POSITIVE[t];
    else if (t in NEGATIVE) w = -NEGATIVE[t];
    if (w === 0) continue;

    // 앞 3토큰 내 부정어 → 극성 반전
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (NEGATORS.has(tokens[j])) {
        w = -w;
        break;
      }
    }
    // 직전 강조어 → 배율
    const prev = tokens[i - 1];
    if (prev && prev in INTENSIFIERS) w *= INTENSIFIERS[prev];

    raw += w;
    weightAbs += Math.abs(w);
    hits.push(t);
  }

  if (weightAbs === 0) return { score: 0, confidence: 0, hits: [] };
  // tanh 스쿼시 — 헤드라인 하나의 영향 상한
  const score = Math.tanh(raw / 3);
  const confidence = Math.min(1, weightAbs / 4);
  return { score: +score.toFixed(3), confidence: +confidence.toFixed(2), hits };
}

export function sentimentLabel(score: number): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (score > 0.15) return "BULLISH";
  if (score < -0.15) return "BEARISH";
  return "NEUTRAL";
}

/** 점수 → 규칙 기반 코멘트 (LLM 아님 — 계산값의 한국어 서술) */
export function assessmentOf(symbol: string, score: number, confidence: number): string {
  const label = sentimentLabel(score);
  if (label === "BULLISH") {
    return confidence > 0.6
      ? `${symbol} 강한 긍정 신호 — 감성 알파 가중치 상향 반영`
      : `${symbol} 완만한 긍정 — 추세 확인 대기`;
  }
  if (label === "BEARISH") {
    return confidence > 0.6
      ? `${symbol} 강한 부정 신호 — 노출 축소 검토`
      : `${symbol} 단기 역풍 가능성 — 모니터링 지속`;
  }
  return `${symbol} 중립 — 알파 기여 없음`;
}
