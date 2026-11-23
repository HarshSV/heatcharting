import type { Bar } from "./indicators";

/** Chart times are UTC seconds shifted by +5:30 so the axis reads in IST. */
export const IST = 19800;
export const SESSION_OPEN = 33300; // 09:15 as seconds after midnight
export const toChartSec = (ms: number) => Math.floor(ms / 1000) + IST;

export interface Interval {
  id: string;
  label: string;
  sec: number; // bar length in seconds (D = 86400, W = 604800)
  angel: string; // Angel One's name for the interval it is built from
  days: number; // calendar days of history to request
  group: "minutes" | "hours" | "days";
  /** the stored heat (best five levels) is only meaningful on bars of at most this many seconds */
  heat: boolean;
}

export const INTERVALS: Interval[] = [
  { id: "1m", label: "1m", sec: 60, angel: "ONE_MINUTE", days: 5, group: "minutes", heat: true },
  { id: "3m", label: "3m", sec: 180, angel: "THREE_MINUTE", days: 10, group: "minutes", heat: true },
  { id: "5m", label: "5m", sec: 300, angel: "FIVE_MINUTE", days: 20, group: "minutes", heat: true },
  { id: "15m", label: "15m", sec: 900, angel: "FIFTEEN_MINUTE", days: 40, group: "minutes", heat: true },
  { id: "30m", label: "30m", sec: 1800, angel: "THIRTY_MINUTE", days: 80, group: "minutes", heat: true },
  { id: "1h", label: "1h", sec: 3600, angel: "ONE_HOUR", days: 150, group: "hours", heat: true },
  { id: "4h", label: "4h", sec: 14400, angel: "ONE_HOUR", days: 300, group: "hours", heat: false },
  { id: "D", label: "D", sec: 86400, angel: "ONE_DAY", days: 730, group: "days", heat: false },
  { id: "W", label: "W", sec: 604800, angel: "ONE_DAY", days: 1800, group: "days", heat: false },
];
export const intervalOf = (id: string): Interval => INTERVALS.find((i) => i.id === id) ?? INTERVALS[2];

/** Start (chart seconds) of the bar that holds time t. NSE intraday bars start at 09:15, so 30m and 1h are counted from the session open. */
export function bucketStart(t: number, iv: Interval): number {
  if (iv.id === "D") return Math.floor(t / 86400) * 86400;
  if (iv.id === "W") return (Math.floor((Math.floor(t / 86400) + 3) / 7) * 7 - 3) * 86400; // weeks start on Monday
  const day = Math.floor(t / 86400) * 86400;
  const open = day + SESSION_OPEN;
  const into = Math.max(0, t - open);
  return open + Math.floor(into / iv.sec) * iv.sec;
}

/** Fold bars into larger ones (open of the first, high/low extremes, close of the last, volume summed). A bar with unknown volume leaves the sum unknown. */
export function aggregate(bars: Bar[], iv: Interval): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const start = bucketStart(b.time, iv);
    const last = out[out.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume = last.volume != null && b.volume != null ? last.volume + b.volume : null;
    } else {
      out.push({ ...b, time: start });
    }
  }
  return out;
}

/** Heikin Ashi candles: smoothed bars that make trend easier to read. */
export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  bars.forEach((b, i) => {
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: b.time, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), volume: b.volume });
  });
  return out;
}

/** Rebase a comparison series so it starts where the main series starts, then both read in the same units. Bars are matched by time. */
export function rebase(main: Bar[], other: Bar[]): { time: number; value: number }[] {
  const byTime = new Map(other.map((b) => [b.time, b.close]));
  const first = main.find((b) => byTime.has(b.time));
  if (!first) return [];
  const k = first.close / (byTime.get(first.time) as number);
  return main.filter((b) => byTime.has(b.time)).map((b) => ({ time: b.time, value: (byTime.get(b.time) as number) * k }));
}
