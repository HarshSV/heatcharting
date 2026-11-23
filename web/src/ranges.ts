/** The range buttons in the bottom bar, the market clock, and the watchlist list rules. Pure, so they can be tested. */
import { IST } from "./transform";

export interface RangeSpec {
  id: string;
  label: string;
  /** calendar days back from the latest bar; null = everything loaded, "ytd" = since 1 January */
  days: number | "ytd" | null;
  /** the timeframe that suits the range */
  interval: string;
}

export const RANGES: RangeSpec[] = [
  { id: "1D", label: "1D", days: 1, interval: "5m" },
  { id: "5D", label: "5D", days: 5, interval: "15m" },
  { id: "1M", label: "1M", days: 30, interval: "1h" },
  { id: "3M", label: "3M", days: 92, interval: "1h" },
  { id: "6M", label: "6M", days: 183, interval: "D" },
  { id: "YTD", label: "YTD", days: "ytd", interval: "D" },
  { id: "1Y", label: "1Y", days: 365, interval: "D" },
  { id: "5Y", label: "5Y", days: 1826, interval: "W" },
  { id: "All", label: "All", days: null, interval: "W" },
];

/** Chart second at which the range starts, or null for "all". `lastBar` is the chart second of the latest bar. */
export function rangeStart(r: RangeSpec, lastBar: number): number | null {
  if (r.days === null) return null;
  if (r.days === "ytd") {
    const y = new Date(lastBar * 1000).getUTCFullYear();
    return Date.UTC(y, 0, 1) / 1000;
  }
  return lastBar - r.days * 86400;
}

/** Index of the first bar at or after `start`, never past the last bar. */
export function firstBarFrom(times: number[], start: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, times.length - 1));
}

export type MarketState = "open" | "pre-open" | "closed";

/** NSE hours from the clock alone: weekdays 09:00 to 09:15 pre-open, 09:15 to 15:30 open. Trading holidays are not known here. */
export function marketState(ms: number): MarketState {
  const d = new Date(ms + IST * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return "closed";
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (m >= 9 * 60 + 15 && m < 15 * 60 + 30) return "open";
  if (m >= 9 * 60 && m < 9 * 60 + 15) return "pre-open";
  return "closed";
}

export function clock(ms: number): string {
  return `${new Date(ms + IST * 1000).toISOString().slice(11, 19)} UTC+5:30`;
}

// ------------------------------------------------------------------ watchlist
export const MAX_WATCH = 30;

export function addSymbol(list: string[], symbol: string, max = MAX_WATCH): string[] {
  const s = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9&-]{1,20}$/.test(s) || list.includes(s) || list.length >= max) return list;
  return [...list, s];
}
export const removeSymbol = (list: string[], symbol: string) => list.filter((s) => s !== symbol);

export function sanitizeWatch(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.reduce<string[]>((acc, v) => (typeof v === "string" ? addSymbol(acc, v) : acc), []);
}

export interface Quote {
  symbol: string;
  ltp: number | null;
  prev_close: number | null;
  change: number | null;
  change_pct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  upper_circuit: number | null;
  lower_circuit: number | null;
  week52_high: number | null;
  week52_low: number | null;
}

/** "+1.23%" or "-" when there is no honest number. */
export const pctText = (p: number | null | undefined) => (typeof p === "number" && Number.isFinite(p) ? `${p >= 0 ? "+" : ""}${p.toFixed(2)}%` : "-");
