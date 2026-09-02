import { assessmentOf, scoreHeadline, sentimentLabel } from "./scorer.js";
import type { NewsItem } from "./news.js";

/**
 * 감성 상태 추적기 — 헤드라인 점수를 심볼별 EMA로 접고,
 * 채점된 피드(근거 포함)를 링버퍼로 유지한다.
 */

export interface ScoredNewsItem extends NewsItem {
  score: number;
  confidence: number;
  label: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** 점수에 기여한 단어 (감사 가능성 — 왜 이 점수인가) */
  evidence: string[];
  /** 규칙 기반 코멘트 */
  assessment: string;
}

export interface SymbolSentiment {
  symbol: string;
  score: number; // EMA [-1,1]
  label: "BULLISH" | "BEARISH" | "NEUTRAL";
  mentions: number;
  /** 가장 최근의 유의미한(|score|>0) 헤드라인 */
  topDriver: string | null;
  updatedAt: string | null;
}

const EMA_ALPHA = 0.3;
const FEED_MAX = 150;

export class SentimentTracker {
  private symbols = new Map<string, SymbolSentiment>();
  feed: ScoredNewsItem[] = [];
  private sourceCounts = new Map<string, number>();

  track(symbol: string) {
    if (!this.symbols.has(symbol)) {
      this.symbols.set(symbol, {
        symbol,
        score: 0,
        label: "NEUTRAL",
        mentions: 0,
        topDriver: null,
        updatedAt: null,
      });
    }
  }

  /** 헤드라인 1건 채점 + 상태 갱신. 반환값은 피드 아이템. */
  ingest(item: NewsItem): ScoredNewsItem {
    this.track(item.symbol);
    const s = this.symbols.get(item.symbol)!;
    const { score, confidence, hits } = scoreHeadline(item.title);

    // 신뢰도로 가중한 EMA — 무의미한 헤드라인(conf=0)은 점수를 끌어내리지 않는다
    if (confidence > 0) {
      const a = EMA_ALPHA * confidence;
      s.score = +(s.score * (1 - a) + score * a).toFixed(3);
    }
    s.mentions += 1;
    s.label = sentimentLabel(s.score);
    if (Math.abs(score) > 0.1) s.topDriver = item.title;
    s.updatedAt = item.fetchedAt;

    this.sourceCounts.set(item.source, (this.sourceCounts.get(item.source) ?? 0) + 1);

    const scored: ScoredNewsItem = {
      ...item,
      score,
      confidence,
      label: sentimentLabel(score),
      evidence: hits,
      assessment: assessmentOf(item.symbol, score, confidence),
    };
    this.feed.unshift(scored);
    if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX;
    return scored;
  }

  bySymbol(): SymbolSentiment[] {
    return [...this.symbols.values()].sort((a, b) => b.score - a.score);
  }

  scoreOf(symbol: string): SymbolSentiment | undefined {
    return this.symbols.get(symbol);
  }

  /** 멘션 가중 평균 시장 감성 지수 */
  marketIndex(): number {
    let num = 0;
    let den = 0;
    for (const s of this.symbols.values()) {
      const w = Math.min(10, s.mentions);
      num += s.score * w;
      den += w;
    }
    return den > 0 ? +(num / den).toFixed(3) : 0;
  }

  totalMentions(): number {
    let n = 0;
    for (const s of this.symbols.values()) n += s.mentions;
    return n;
  }

  sources(): Array<{ name: string; count: number }> {
    return [...this.sourceCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }
}
