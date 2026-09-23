import { fmtTokens } from "./telemetryFormat";

export type ContextUsageLevel = "ok" | "warn" | "critical";

export interface ContextUsageView {
  /** 0..1 share of the window in use; clamped so a stale size never exceeds 1. */
  fraction: number;
  /** Whole-number percentage for display. */
  percent: number;
  level: ContextUsageLevel;
  /** e.g. "71.2k / 200.0k". */
  tokens: string;
  /** e.g. "36%". */
  percentLabel: string;
}

/** Above these shares of the window, the display changes tone. */
export const WARN_AT = 0.7;
export const CRITICAL_AT = 0.9;

/** Pure presentation of a context-window reading; safe for a zero-sized window. */
export function describeContextUsage(used: number, size: number): ContextUsageView {
  const fraction = size > 0 ? Math.min(1, Math.max(0, used / size)) : 0;
  const percent = Math.round(fraction * 100);
  const level: ContextUsageLevel =
    fraction >= CRITICAL_AT ? "critical" : fraction >= WARN_AT ? "warn" : "ok";
  return {
    fraction,
    percent,
    level,
    tokens: `${fmtTokens(used)} / ${size > 0 ? fmtTokens(size) : "?"}`,
    percentLabel: size > 0 ? `${percent}%` : "—",
  };
}
