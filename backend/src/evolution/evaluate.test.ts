import { describe, expect, it } from "vitest";
import { MIN_TRAIN_DAYS, pickExamWindow } from "./evaluate.js";

const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

describe("pickExamWindow", () => {
  it("keeps the window after the minimum training span and inside the dates", () => {
    for (const r of [0, 0.37, 0.999]) {
      const w = pickExamWindow({ datesLen: 365, examDays: 60, rand: () => r });
      expect(w.start).toBeGreaterThanOrEqual(MIN_TRAIN_DAYS);
      expect(w.end).toBe(w.start + 60);
      expect(w.end).toBeLessThanOrEqual(364);
    }
    expect(pickExamWindow({ datesLen: 365, examDays: 60, rand: () => 0 }).choices).toBe(364 - 60 - 80 + 1);
  });
  it("re-draws when the pick sits within minGap of the previous window", () => {
    // 첫 뽑기 = 이전 창과 같은 자리(80), 두 번째 = 멀리
    const w = pickExamWindow({ datesLen: 365, examDays: 60, rand: seq(0, 0.9), prevStart: 80 });
    expect(Math.abs(w.start - 80)).toBeGreaterThanOrEqual(30);
  });
  it("different generations get different papers from different seeds", () => {
    const a = pickExamWindow({ datesLen: 365, examDays: 60, rand: () => 0.1 });
    const b = pickExamWindow({ datesLen: 365, examDays: 60, rand: () => 0.8 });
    expect(a.start).not.toBe(b.start);
  });
  it("falls back to the latest window when history is too short for a choice", () => {
    const w = pickExamWindow({ datesLen: 120, examDays: 60, rand: () => 0.5 });
    expect(w.start).toBeLessThanOrEqual(MIN_TRAIN_DAYS);
    expect(w.end).toBe(119);
    expect(w.choices).toBe(1);
  });
});
