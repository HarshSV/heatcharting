import { describe, expect, it } from "vitest";
import { RANGES, addSymbol, clock, firstBarFrom, marketState, pctText, rangeStart, removeSymbol, sanitizeWatch } from "./ranges";
import { IST } from "./transform";

const r = (id: string) => RANGES.find((x) => x.id === id)!;
const ms = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) - IST * 1000; // an IST wall-clock time as epoch ms

describe("range buttons", () => {
  it("count back from the latest bar, since 1 January for YTD, and everything for All", () => {
    const last = Date.UTC(2026, 10, 23, 10, 0) / 1000;
    expect(rangeStart(r("5D"), last)).toBe(last - 5 * 86400);
    expect(rangeStart(r("YTD"), last)).toBe(Date.UTC(2026, 0, 1) / 1000);
    expect(rangeStart(r("All"), last)).toBeNull();
  });
  it("each range names a timeframe the chart has", () => {
    expect(RANGES.map((x) => x.label)).toEqual(["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "All"]);
    expect(new Set(RANGES.map((x) => x.interval))).toEqual(new Set(["5m", "15m", "1h", "D", "W"]));
  });
  it("finds the first bar inside a range and never falls off the end", () => {
    const t = [100, 200, 300, 400];
    expect(firstBarFrom(t, 250)).toBe(2);
    expect(firstBarFrom(t, 0)).toBe(0);
    expect(firstBarFrom(t, 9999)).toBe(3);
    expect(firstBarFrom([], 5)).toBe(0);
  });
});

describe("market clock", () => {
  it("opens at 09:15 and closes at 15:30 on weekdays only", () => {
    expect(marketState(ms(2026, 11, 23, 9, 14))).toBe("pre-open"); // a Monday
    expect(marketState(ms(2026, 11, 23, 9, 15))).toBe("open");
    expect(marketState(ms(2026, 11, 23, 15, 29))).toBe("open");
    expect(marketState(ms(2026, 11, 23, 15, 30))).toBe("closed");
    expect(marketState(ms(2026, 11, 23, 8, 0))).toBe("closed");
    expect(marketState(ms(2026, 11, 21, 11, 0))).toBe("closed"); // a Saturday
    expect(marketState(ms(2026, 11, 22, 11, 0))).toBe("closed"); // a Sunday
  });
  it("shows the clock in IST", () => {
    expect(clock(ms(2026, 11, 23, 11, 43) + 14000)).toBe("11:43:14 UTC+5:30");
  });
});

describe("watchlist", () => {
  it("adds upper-cased symbols once, rejects junk and respects the limit", () => {
    expect(addSymbol([], " tcs ")).toEqual(["TCS"]);
    expect(addSymbol(["TCS"], "tcs")).toEqual(["TCS"]);
    expect(addSymbol([], "bad symbol!")).toEqual([]);
    expect(addSymbol(["A", "B"], "C", 2)).toEqual(["A", "B"]);
    expect(removeSymbol(["A", "B"], "A")).toEqual(["B"]);
  });
  it("repairs whatever storage hands back", () => {
    expect(sanitizeWatch(["tcs", "TCS", 5, null, "INFY", "no way!"])).toEqual(["TCS", "INFY"]);
    expect(sanitizeWatch("nope")).toEqual([]);
  });
  it("shows no percentage rather than a made-up one", () => {
    expect(pctText(1.234)).toBe("+1.23%");
    expect(pctText(-0.5)).toBe("-0.50%");
    expect(pctText(null)).toBe("-");
    expect(pctText(Number.NaN)).toBe("-");
  });
});
