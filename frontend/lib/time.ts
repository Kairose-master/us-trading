import type { MarketSession } from "./types"

const ET = "America/New_York"
const KST = "Asia/Seoul"

interface EtParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number // 0=Sun .. 6=Sat
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function getEtParts(date: Date = new Date()): EtParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  }
}

/** ET UTC offset in hours (e.g. -5 standard, -4 during DST). Computed, never hardcoded. */
export function getEtOffsetHours(date: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: ET, timeZoneName: "shortOffset" })
  const tzPart = fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5"
  const m = tzPart.match(/GMT([+-]\d+)(?::(\d+))?/)
  if (!m) return -5
  const h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  return h + (h < 0 ? -min / 60 : min / 60)
}

export function isEtDst(date: Date = new Date()): boolean {
  return getEtOffsetHours(date) === -4
}

/** Session computed from America/New_York wall-clock (DST-safe). */
export function getMarketSession(date: Date = new Date()): MarketSession {
  const { hour, minute, weekday } = getEtParts(date)
  if (weekday === 0 || weekday === 6) return "closed"
  const mins = hour * 60 + minute
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre"
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular"
  if (mins >= 16 * 60 && mins < 20 * 60) return "after"
  return "closed"
}

export const SESSION_LABEL: Record<MarketSession, string> = {
  pre: "프리마켓",
  regular: "정규장",
  after: "애프터마켓",
  closed: "휴장",
}

/** "정규장: 한국시간 23:30–06:00" helper text, DST-aware. */
export function getRegularSessionKstText(date: Date = new Date()): string {
  return isEtDst(date) ? "정규장: 한국시간 22:30–05:00" : "정규장: 한국시간 23:30–06:00"
}

/** Build a real Date for a given ET wall-clock time on a given ET calendar day. */
function etWallTimeToDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  // First guess using the current-ish offset, then correct once for DST boundary days.
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute))
  for (let i = 0; i < 2; i++) {
    const offset = getEtOffsetHours(guess)
    guess = new Date(Date.UTC(year, month - 1, day, hour - offset, minute))
  }
  return guess
}

/** Next regular-session open (09:30 ET on the next trading weekday). */
export function getNextRegularOpen(date: Date = new Date()): Date {
  for (let addDays = 0; addDays < 8; addDays++) {
    const probe = new Date(date.getTime() + addDays * 86400000)
    const p = getEtParts(probe)
    if (p.weekday === 0 || p.weekday === 6) continue
    const open = etWallTimeToDate(p.year, p.month, p.day, 9, 30)
    if (open.getTime() > date.getTime()) return open
  }
  return new Date(date.getTime() + 86400000)
}

/** Next pre-market open (04:00 ET on the next trading weekday). */
export function getNextPreOpen(date: Date = new Date()): Date {
  for (let addDays = 0; addDays < 8; addDays++) {
    const probe = new Date(date.getTime() + addDays * 86400000)
    const p = getEtParts(probe)
    if (p.weekday === 0 || p.weekday === 6) continue
    const open = etWallTimeToDate(p.year, p.month, p.day, 4, 0)
    if (open.getTime() > date.getTime()) return open
  }
  return new Date(date.getTime() + 86400000)
}

export function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)
}

export function formatEtClock(date: Date = new Date()): string {
  return formatClock(date, ET)
}

export function formatKstClock(date: Date = new Date()): string {
  return formatClock(date, KST)
}

export function formatTsKst(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

export function formatTsEt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

/** "5시간 12분 34초" countdown string. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0초"
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}시간 ${m}분 ${sec}초`
  if (m > 0) return `${m}분 ${sec}초`
  return `${sec}초`
}
