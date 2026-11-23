import { describe, expect, it } from "vitest";
import { atr, bollinger, ema, macd, rsi, sma, vwap, type Bar } from "./indicators";
import { INTERVALS, SESSION_OPEN, aggregate, bucketStart, heikinAshi, intervalOf, rebase } from "./transform";

const bar = (time: number, o: number, h: number, l: number, c: number, v: number | null = 100): Bar => ({ time, open: o, high: h, low: l, close: c, volume: v });

describe("moving averages", () => {
  it("sma is null until it has n values, then the plain average", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("sma does not average over a gap", () => {
    expect(sma([1, 2, null, 4, 5, 6], 3)).toEqual([null, null, null, null, null, 5]);
  });
  it("ema starts from the simple average of the first n and follows the 2/(n+1) rule", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBe(2);
    expect(e[3]).toBeCloseTo(3);
    expect(e[4]).toBeCloseTo(4);
  });
});

describe("vwap", () => {
  it("weights typical price by volume and restarts each day", () => {
    const d = 86400;
    const v = vwap([bar(0, 10, 12, 8, 10, 100), bar(60, 10, 14, 10, 12, 300), bar(d, 50, 50, 50, 50, 10)]);
    expect(v[0]).toBeCloseTo(10);
    expect(v[1]).toBeCloseTo((10 * 100 + 12 * 300) / 400);
    expect(v[2]).toBe(50);
  });
  it("is null while nothing has traded, never zero", () => {
    expect(vwap([bar(0, 10, 10, 10, 10, null), bar(60, 10, 10, 10, 10, 0)])).toEqual([null, null]);
  });
});

describe("bollinger, rsi, macd, atr", () => {
  it("bollinger bands collapse on a flat series and widen with variance", () => {
    const flat = bollinger([5, 5, 5, 5, 5], 3, 2);
    expect(flat.upper[4]).toBe(5);
    const b = bollinger([1, 2, 3], 3, 2);
    expect(b.mid[2]).toBe(2);
    expect(b.upper[2]! - b.mid[2]!).toBeCloseTo(2 * Math.sqrt(2 / 3));
  });
  it("rsi is 100 on a pure rise, near 0 on a pure fall, and null before n changes", () => {
    const up = rsi([1, 2, 3, 4, 5, 6], 3);
    expect(up.slice(0, 3)).toEqual([null, null, null]);
    expect(up[3]).toBe(100);
    expect(rsi([6, 5, 4, 3, 2, 1], 3)[3]).toBeCloseTo(0);
  });
  it("macd histogram is the line minus its signal", () => {
    const vals = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5 + i * 0.2);
    const m = macd(vals);
    const i = 59;
    expect(m.macd[i]).not.toBeNull();
    expect(m.hist[i]).toBeCloseTo((m.macd[i] as number) - (m.signal[i] as number));
    expect(m.macd[10]).toBeNull();
  });
  it("atr averages true range", () => {
    const bars = [bar(0, 10, 12, 8, 10), bar(1, 10, 13, 9, 12), bar(2, 12, 14, 11, 13), bar(3, 13, 15, 12, 14)];
    const a = atr(bars, 3);
    expect(a[1]).toBeNull();
    expect(a[2]).toBeCloseTo((4 + 4 + 3) / 3);
  });
});

describe("intervals and bars", () => {
  it("intraday bars start at 09:15, so 1h and 30m are counted from the open", () => {
    const day = 19_000 * 86400;
    const open = day + SESSION_OPEN;
    expect(bucketStart(open + 3599, intervalOf("1h"))).toBe(open);
    expect(bucketStart(open + 3600, intervalOf("1h"))).toBe(open + 3600);
    expect(bucketStart(open + 2000, intervalOf("30m"))).toBe(open + 1800);
    expect(bucketStart(open + 100, intervalOf("5m"))).toBe(open);
    expect(bucketStart(day + 80000, intervalOf("D"))).toBe(day);
  });
  it("weeks start on Monday", () => {
    const monday = (Math.floor(19_000 / 7) * 7 + 4) * 86400; // some Monday: day index where (d+3)%7==0
    const d = monday / 86400;
    expect((d + 3) % 7).toBe(0);
    expect(bucketStart(monday + 4 * 86400 + 500, intervalOf("W"))).toBe(monday);
  });
  it("aggregate keeps first open, extremes, last close and a summed volume that stays unknown if any part is", () => {
    const open = 19_000 * 86400 + SESSION_OPEN;
    const four = intervalOf("4h");
    const out = aggregate([bar(open, 10, 11, 9, 10.5, 100), bar(open + 3600, 10.5, 13, 10, 12, 50), bar(open + 3600 * 5, 12, 12, 11, 11.5, null)], four);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ time: open, open: 10, high: 13, low: 9, close: 12, volume: 150 });
    expect(out[1].volume).toBeNull();
  });
  it("heikin ashi opens at the middle of the previous smoothed bar", () => {
    const h = heikinAshi([bar(0, 10, 12, 9, 11), bar(1, 11, 14, 10, 13)]);
    expect(h[0].close).toBe(10.5);
    expect(h[1].open).toBeCloseTo((h[0].open + h[0].close) / 2);
    expect(h[1].high).toBeGreaterThanOrEqual(Math.max(h[1].open, h[1].close));
  });
  it("rebase scales the other symbol to start where the main one starts, matching by time", () => {
    const r = rebase([bar(1, 0, 0, 0, 100), bar(2, 0, 0, 0, 110), bar(3, 0, 0, 0, 120)], [bar(2, 0, 0, 0, 50), bar(3, 0, 0, 0, 60)]);
    expect(r.map((x) => x.time)).toEqual([2, 3]);
    expect(r[0].value).toBeCloseTo(110);
    expect(r[1].value).toBeCloseTo(132);
    expect(rebase([bar(1, 0, 0, 0, 1)], [bar(9, 0, 0, 0, 1)])).toEqual([]);
  });
  it("has the toolbar's timeframes", () => {
    expect(INTERVALS.map((i) => i.id)).toEqual(["1m", "3m", "5m", "15m", "30m", "1h", "4h", "D", "W"]);
  });
});
