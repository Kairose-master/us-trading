type Level = "INFO" | "WARN" | "ERROR";

export interface LogEntry {
  ts: string;
  level: Level;
  message: string;
  context?: Record<string, unknown>;
}

const ring: LogEntry[] = [];
const RING_MAX = 2000;

function log(level: Level, message: string, context?: Record<string, unknown>) {
  const entry: LogEntry = { ts: new Date().toISOString(), level, message, context };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  const line = `[${entry.ts}] ${level} ${message}`;
  if (level === "ERROR") console.error(line, context ?? "");
  else console.log(line, context ?? "");
}

export const logger = {
  info: (m: string, c?: Record<string, unknown>) => log("INFO", m, c),
  warn: (m: string, c?: Record<string, unknown>) => log("WARN", m, c),
  error: (m: string, c?: Record<string, unknown>) => log("ERROR", m, c),
  recent: (limit = 100) => ring.slice(-limit).reverse(),
};
