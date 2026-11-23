import { describe, expect, it } from "vitest";
import { aggregate, barIndex, deltaSeries, profile, rowStep, totals, type FlowEvent } from "./flow";
import { distToRay, distToSegment, duration, fibPrices, inRect, measure, snapPrice } from "./geometry";
import { IST } from "./transform";

// bars every 60 chart seconds starting at chart time 1000; an event at chart second s has ms (s - IST) * 1000
const bars = [1000, 1060, 1120, 1180];
const ev = (s: number, price: number, qty: number, side: number): FlowEvent => [(s - IST) * 1000, price, qty, side];

describe("flow aggregation", () => {
  it("finds the bar that holds a time", () => {
    expect(barIndex(bars, 999)).toBe(-1);
    expect(barIndex(bars, 1000)).toBe(0);
    expect(barIndex(bars, 1119)).toBe(1);
    expect(barIndex(bars, 5000)).toBe(3);
  });
  it("splits buy, sell and unclassified quantity per bar and price row", () => {
    const a = aggregate([ev(1010, 100.0, 10, 1), ev(1020, 100.0, 4, -1), ev(1030, 100.05, 7, 0), ev(1070, 100.0, 5, 1)], bars, 0.05);
    expect(a.get(0)!.get(100)).toEqual({ buy: 10, sell: 4, other: 0 });
    expect(a.get(0)!.get(100.05)).toEqual({ buy: 0, sell: 0, other: 7 });
    expect(a.get(1)!.get(100)).toEqual({ buy: 5, sell: 0, other: 0 });
    expect(totals(a.get(0)!)).toEqual({ buy: 10, sell: 4, other: 7, delta: 6, total: 21 });
  });
  it("merges prices into wider rows", () => {
    const a = aggregate([ev(1010, 100.0, 1, 1), ev(1011, 100.05, 2, 1), ev(1012, 100.2, 4, 1)], bars, 0.25);
    expect([...a.get(0)!.keys()].sort()).toEqual([100, 100.25]);
    expect(a.get(0)!.get(100)!.buy).toBe(3);
  });
  it("leaves out what is after the replay cursor", () => {
    const a = aggregate([ev(1010, 100, 1, 1), ev(1100, 100, 9, 1)], bars, 0.05, (1050 - IST) * 1000);
    expect(a.size).toBe(1);
  });
  it("delta and its running total start where flow was first recorded; earlier bars are unknown, not zero", () => {
    const d = deltaSeries([ev(1070, 100, 10, 1), ev(1080, 100, 3, -1), ev(1130, 100, 5, 1)], bars, 60);
    expect(d.delta).toEqual([null, 7, 5, 0]);
    expect(d.cvd).toEqual([null, 7, 12, 12]);
    expect(deltaSeries([], bars, 60)).toEqual({ delta: [null, null, null, null], cvd: [null, null, null, null] });
  });
  it("profile adds up volume at price over a time span and names the price of most volume", () => {
    const p = profile([ev(1010, 100, 10, 1), ev(1020, 100, 5, -1), ev(1030, 100.05, 3, 1), ev(9000, 100, 99, 1)], 1000, 1200, 0.05);
    expect(p.rows).toEqual([{ price: 100, buy: 10, sell: 5, other: 0, total: 15 }, { price: 100.05, buy: 3, sell: 0, other: 0, total: 3 }]);
    expect(p.poc).toBe(100);
    expect(p.max).toBe(15);
    expect(profile([], 0, 10, 0.05)).toEqual({ rows: [], poc: null, max: 0 });
  });
  it("chooses a row height that is at least as tall as asked", () => {
    expect(rowStep(0.05, 0.001)).toBe(0.05);                    // very zoomed in: one tick per row
    const s = rowStep(0.05, 0.02);                              // 13 px at 0.02 per px is 0.26: next nice multiple
    expect(s).toBeGreaterThanOrEqual(0.26);
    expect(Math.round(s / 0.05 * 1e6) / 1e6 % 1).toBe(0);       // a whole number of ticks
    expect(rowStep(0, 1)).toBe(0.05);
  });
});

describe("drawing geometry", () => {
  it("distance to a segment stops at its ends, a ray goes on", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distToSegment({ x: 5, y: 3 }, a, b)).toBe(3);
    expect(distToSegment({ x: 20, y: 0 }, a, b)).toBe(10);
    expect(distToRay({ x: 20, y: 0 }, a, b)).toBe(0);
    expect(distToRay({ x: -5, y: 0 }, a, b)).toBe(5);
    expect(distToSegment({ x: 3, y: 4 }, a, a)).toBe(5);
  });
  it("tells whether a point is inside a rectangle given any two opposite corners", () => {
    expect(inRect({ x: 5, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 0 })).toBe(true);
    expect(inRect({ x: 11, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 10 })).toBe(false);
    expect(inRect({ x: 11, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 10 }, 2)).toBe(true);
  });
  it("fibonacci retracement puts 0 at the end of the move and 1 at its start", () => {
    const f = fibPrices(100, 200);
    expect(f[0]).toEqual({ level: 0, price: 200 });
    expect(f[f.length - 1]).toEqual({ level: 1, price: 100 });
    expect(f.find((x) => x.level === 0.5)!.price).toBe(150);
    expect(fibPrices(200, 100).find((x) => x.level === 0.5)!.price).toBe(150);
  });
  it("measures a move without inventing a percentage from a zero start", () => {
    expect(measure({ t: 0, p: 100 }, { t: 600, p: 110 }, 60)).toEqual({ dPrice: 10, pct: 10, bars: 10, seconds: 600 });
    expect(measure({ t: 0, p: 0 }, { t: 60, p: 5 }, 60).pct).toBeNull();
  });
  it("writes durations and snaps to the nearest of open, high, low, close inside the tolerance", () => {
    expect(duration(45 * 60)).toBe("45m");
    expect(duration(3 * 3600 + 15 * 60)).toBe("3h 15m");
    expect(duration(2 * 86400 + 3 * 3600)).toBe("2d 3h");
    expect(snapPrice(100.3, [100, 101, 99.5], 0.5)).toBe(100);
    expect(snapPrice(100.3, [101, 99], 0.5)).toBe(100.3);
  });
});
