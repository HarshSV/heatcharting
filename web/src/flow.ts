import { toChartSec } from "./transform";

/** [time ms, price, quantity, side] where side is 1 for a buy, -1 for a sell and 0 when it could not be told. Estimated from one-second snapshots. */
export type FlowEvent = [t: number, price: number, qty: number, side: number];

export interface Cell {
  buy: number;
  sell: number;
  other: number; // quantity whose side could not be told
}

/** Row height in price for the footprint and the profile: a multiple of the tick (1, 2, 5, 10 ...) that is at least `minPx` tall on screen. */
export function rowStep(tick: number, pricePerPx: number, minPx = 13): number {
  if (!(tick > 0) || !(pricePerPx > 0)) return tick > 0 ? tick : 0.05;
  const need = (minPx * pricePerPx) / tick;
  if (need <= 1) return tick;
  const k = 10 ** Math.floor(Math.log10(need));
  const m = need / k;
  const mult = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return Math.round(tick * mult * k * 1e6) / 1e6;
}

/** Index of the bar that holds chart-second `sec`, or -1 when it is before the first bar. */
export function barIndex(barTimes: number[], sec: number): number {
  if (!barTimes.length || sec < barTimes[0]) return -1;
  let lo = 0;
  let hi = barTimes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (barTimes[mid] <= sec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const bucket = (price: number, step: number) => Math.round(Math.round(price / step) * step * 1e6) / 1e6;

/** Quantity per bar and price row. `cutoffMs` leaves out everything after the replay cursor. */
export function aggregate(events: FlowEvent[], barTimes: number[], step: number, cutoffMs: number | null = null): Map<number, Map<number, Cell>> {
  const out = new Map<number, Map<number, Cell>>();
  for (const [t, price, qty, side] of events) {
    if (cutoffMs != null && t > cutoffMs) break;
    const i = barIndex(barTimes, toChartSec(t));
    if (i < 0) continue;
    const row = bucket(price, step);
    let rows = out.get(i);
    if (!rows) out.set(i, (rows = new Map()));
    let c = rows.get(row);
    if (!c) rows.set(row, (c = { buy: 0, sell: 0, other: 0 }));
    if (side > 0) c.buy += qty;
    else if (side < 0) c.sell += qty;
    else c.other += qty;
  }
  return out;
}

export function totals(rows: Map<number, Cell>): { buy: number; sell: number; other: number; delta: number; total: number } {
  let buy = 0;
  let sell = 0;
  let other = 0;
  for (const c of rows.values()) {
    buy += c.buy;
    sell += c.sell;
    other += c.other;
  }
  return { buy, sell, other, delta: buy - sell, total: buy + sell + other };
}

/** Delta (buy minus sell) and its running total per bar. A bar that ended before any flow was recorded is null: unknown, not zero. */
export function deltaSeries(events: FlowEvent[], barTimes: number[], barSec: number, cutoffMs: number | null = null): { delta: (number | null)[]; cvd: (number | null)[] } {
  const delta: (number | null)[] = barTimes.map(() => null);
  const cvd: (number | null)[] = barTimes.map(() => null);
  if (!events.length) return { delta, cvd };
  const firstBar = barIndex(barTimes, toChartSec(events[0][0]));
  const sums = new Array<number>(barTimes.length).fill(0);
  for (const [t, , qty, side] of events) {
    if (cutoffMs != null && t > cutoffMs) break;
    const i = barIndex(barTimes, toChartSec(t));
    if (i >= 0) sums[i] += side > 0 ? qty : side < 0 ? -qty : 0;
  }
  void barSec;
  let run = 0;
  for (let i = Math.max(0, firstBar); i < barTimes.length; i++) {
    delta[i] = sums[i];
    run += sums[i];
    cvd[i] = run;
  }
  return { delta, cvd };
}

export interface ProfileRow {
  price: number;
  buy: number;
  sell: number;
  other: number;
  total: number;
}

/** Volume at price between two chart times, with the price of most volume (point of control). */
export function profile(events: FlowEvent[], fromSec: number, toSec: number, step: number, cutoffMs: number | null = null): { rows: ProfileRow[]; poc: number | null; max: number } {
  const map = new Map<number, Cell>();
  for (const [t, price, qty, side] of events) {
    if (cutoffMs != null && t > cutoffMs) break;
    const s = toChartSec(t);
    if (s < fromSec || s > toSec) continue;
    const row = bucket(price, step);
    const c = map.get(row) ?? { buy: 0, sell: 0, other: 0 };
    if (side > 0) c.buy += qty;
    else if (side < 0) c.sell += qty;
    else c.other += qty;
    map.set(row, c);
  }
  const rows = [...map.entries()].map(([price, c]) => ({ price, ...c, total: c.buy + c.sell + c.other })).sort((a, b) => a.price - b.price);
  let poc: number | null = null;
  let max = 0;
  for (const r of rows) if (r.total > max) (max = r.total), (poc = r.price);
  return { rows, poc, max };
}
