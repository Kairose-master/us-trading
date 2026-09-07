import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineEngine, EDGES, NODE_DEFS, type PipelineContext } from './engine.js';
import { allocateRisk, POLICY, validateTick } from './guards.js';
import type { PipelineTick } from './types.js';

const tick = (i = 0, symbol = 'BTC'): PipelineTick => ({ symbol, last: 100 + i, bid: 99.99 + i, ask: 100.01 + i, bidSize: 10, askSize: 1, volume: 100 + i });
const context = (): PipelineContext => ({ positionOf: () => null, positionsCount: () => 0, equity: () => 10000, maxWeightPct: () => 25, riskCheck: () => null });
const warm = (engine: PipelineEngine, symbol = 'BTC') => { for (let i = 0; i < 25; i++) engine.onTick(tick(i, symbol)); };
let engine: PipelineEngine;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T00:00:00Z')); engine = new PipelineEngine(context()); engine.start(['BTC']); });
afterEach(() => vi.useRealTimers());

describe('live pipeline gates', () => {
  it('warms up before proposing and exposes measured nodes', () => {
    for (let i = 0; i < 20; i++) engine.onTick(tick(i));
    expect(engine.portfolioTargets).toEqual([]);
    engine.onTick(tick(20));
    expect(engine.portfolioTargets[0].targetWeightPct).toBeGreaterThan(0);
    expect(engine.snapshot().nodesTotal).toBe(14);
    for (const id of ['data-quality', 'signal-eligibility', 'risk-allocation', 'tradability-gate']) expect(engine.nodeDetail(id)?.metrics.totalMsgs).toBeGreaterThan(0);
  });
  it.each([NaN, Infinity, 0, -1])('rejects invalid price %s before features', last => {
    engine.onTick({ ...tick(), last });
    expect(engine.nodeDetail('technical')?.metrics.totalMsgs).toBe(0);
    expect(engine.signals).toEqual([]);
  });
  it('withdraws an existing target after malformed input and recovers', () => {
    warm(engine); engine.onTick({ ...tick(), last: NaN });
    expect(engine.portfolioTargets).toEqual([]);
    engine.onTick(tick(26)); expect(engine.portfolioTargets.length).toBe(1);
  });
  it('expires targets even without incoming events', () => {
    warm(engine); vi.advanceTimersByTime(POLICY.maxAgeMs + 1);
    expect(engine.portfolioTargets).toEqual([]);
    expect(engine.nodeDetail('technical')?.metrics.throughputPerSec).toBe(0);
    warm(engine, 'ETH'); expect(engine.portfolioTargets.map(t => t.symbol)).toEqual(['ETH']);
  });
  it('requires a fresh warmup after a long feed gap', () => {
    warm(engine); vi.advanceTimersByTime(POLICY.maxAgeMs + 1);
    engine.onTick(tick(26)); expect(engine.portfolioTargets).toEqual([]);
  });
  it('never uses replay candles to warm up or emit live signals', () => {
    for (let i = 0; i < 30; i++) engine.onTick({ ...tick(i), replay: true });
    expect(engine.signals).toEqual([]);
    expect(engine.nodeDetail('technical')?.metrics.totalMsgs).toBe(0);
  });
  it.each(['missing', 'wide', 'risk'])('blocks %s before public targets', kind => {
    const ctx = context(); if (kind === 'risk') ctx.riskCheck = () => 'KILL_SWITCH';
    engine = new PipelineEngine(ctx); engine.start(['BTC']);
    for (let i = 0; i < 25; i++) engine.onTick({ ...tick(i), ...(kind === 'missing' ? { bidSize: 0 } : kind === 'wide' ? { ask: 105 + i } : {}) });
    expect(engine.portfolioTargets).toEqual([]);
    expect(engine.signals).toEqual([]);
    expect(engine.nodeDetail('tradability-gate')?.sample.rows.length).toBeGreaterThan(0);
  });
  it('deduplicates news and rejects synthetic or stale headlines', () => {
    const now = new Date().toISOString();
    const n = { id: 'n1', symbol: 'BTC', title: 'record profit growth', source: 'Reuters', url: null, publishedAt: now, fetchedAt: now };
    engine.onNews([n, n, { ...n, id: 'mock', source: 'MockWire' }, { ...n, id: 'old', publishedAt: '2020-01-01' }]);
    expect(engine.tracker.totalMentions()).toBe(1);
    expect(engine.portfolioTargets).toEqual([]);
  });
  it('has a connected acyclic graph', () => {
    const pending = new Set(NODE_DEFS.map(n => n.id));
    for (const edge of EDGES) { expect(pending.has(edge.from)).toBe(true); expect(pending.has(edge.to)).toBe(true); }
    while (pending.size) {
      const roots = [...pending].filter(id => !EDGES.some(e => e.to === id && pending.has(e.from)));
      expect(roots.length).toBeGreaterThan(0);
      if (!roots.length) break;
      roots.forEach(id => pending.delete(id));
    }
  });
});

it('validates source clock and crossed books', () => {
  const now = Date.now();
  expect(validateTick({ ...tick(), observedAt: now - POLICY.maxAgeMs - 1 }, now)).toBe('STALE_OR_FUTURE_TICK');
  expect(validateTick({ ...tick(), observedAt: now }, now, now)).toBe('OUT_OF_ORDER_TICK');
  expect(validateTick({ ...tick(), bid: 102 }, now)).toBe('CROSSED_OR_PARTIAL_BOOK');
});
it('allocates less to higher volatility with hard exposure caps and cash residual', () => {
  const weights = allocateRisk([{ symbol: 'A', alpha: 0.5, confidence: 1, volatilityPct: 1 }, { symbol: 'B', alpha: 0.5, confidence: 1, volatilityPct: 2 }], 80);
  expect(weights.get('A')).toBe(60); expect(weights.get('B')).toBe(30);
  expect([...allocateRisk(Array.from({ length: 20 }, (_, i) => ({ symbol: String(i), alpha: 1, confidence: 1, volatilityPct: 0 })), 25).values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(90);
  expect(allocateRisk([], 25).size).toBe(0);
  expect(allocateRisk([{ symbol: 'A', alpha: NaN, confidence: 1, volatilityPct: 1 }], 25).size).toBe(0);
});
