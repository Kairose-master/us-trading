import type { MarketSession } from "../kis/types.js";

/**
 * 미국장 세션 계산 — 반드시 America/New_York 타임존 기준으로 계산 (DST 자동 반영).
 * pre: 04:00–09:30 / regular: 09:30–16:00 / after: 16:00–20:00 ET, 주말 휴장.
 * (공휴일 캘린더는 추후 추가 — TODO)
 */
export function currentMarketSession(now = new Date()): MarketSession {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = parts.weekday as string;
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
  if (mins >= 16 * 60 && mins < 20 * 60) return "after";
  return "closed";
}

/** 다음 정규장 시작 시각(ET 문자열) — 프론트 카운트다운용 (간이 구현) */
export function nextRegularOpenEt(now = new Date()): string {
  const d = new Date(now);
  for (let i = 0; i < 7; i++) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    if (parts.weekday !== "Sat" && parts.weekday !== "Sun") {
      const candidate = `${parts.year}-${parts.month}-${parts.day}T09:30:00 ET`;
      if (i > 0 || currentMarketSession(now) === "closed" || currentMarketSession(now) === "after")
        return candidate;
      return candidate;
    }
    d.setDate(d.getDate() + 1);
  }
  return "";
}
