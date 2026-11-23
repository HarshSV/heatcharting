import { describe, expect, it } from "vitest";
import { crossed, directionFor, evaluate, type Alert } from "./alerts";
import { newAccount, order, realisedTotal, unrealised } from "./paper";
import { DEFAULT_LAYOUT, History, cloneLayout, describe as label, newIndicator, sanitizeLayout } from "./state";
import { INTERVALS } from "./transform";

const ids = INTERVALS.map((i) => i.id);

describe("alerts", () => {
  it("an alert above waits for a rise, one below for a fall, and a level equal to the price counts as above", () => {
    expect(directionFor(105, 100)).toBe("above");
    expect(directionFor(95, 100)).toBe("below");
    expect(directionFor(100, 100)).toBe("above");
    expect(directionFor(100, null)).toBe("above");
  });
  it("fires on the tick that reaches the level, not before and not twice", () => {
    const up = { price: 100, dir: "above" as const };
    expect(crossed(up, 99.9, 100)).toBe(true);
    expect(crossed(up, 99.5, 99.9)).toBe(false);
    expect(crossed(up, 100.5, 101)).toBe(false);
    expect(crossed({ price: 100, dir: "below" }, 100.1, 99.95)).toBe(true);
  });
  it("never fires without a previous price (unknown is not a crossing)", () => {
    expect(crossed({ price: 100, dir: "above" }, null, 150)).toBe(false);
    expect(crossed({ price: 100, dir: "above" }, 90, null)).toBe(false);
  });
  it("evaluate returns only untriggered alerts of that symbol", () => {
    const mk = (id: string, symbol: string, triggered?: number): Alert => ({ id, symbol, price: 100, dir: "above", created: 1, triggered });
    expect(evaluate([mk("a", "TCS"), mk("b", "INFY"), mk("c", "TCS", 5)], "TCS", 99, 101).map((a) => a.id)).toEqual(["a"]);
  });
});

describe("paper trading", () => {
  it("buys at the price and takes the cash", () => {
    const r = order(newAccount(10_000), "TCS", "buy", 10, 100, 1);
    expect(r.ok && r.account.cash).toBe(9_000);
    expect(r.ok && r.account.positions.TCS).toEqual({ symbol: "TCS", qty: 10, avg: 100 });
  });
  it("averages additions and books profit when closing", () => {
    let a = newAccount(100_000);
    for (const [side, q, p] of [["buy", 10, 100], ["buy", 10, 110], ["sell", 20, 120]] as const) {
      const r = order(a, "TCS", side, q, p, 1);
      if (!r.ok) throw new Error(r.error);
      a = r.account;
    }
    expect(a.positions.TCS).toBeUndefined();
    expect(realisedTotal(a)).toBeCloseTo(20 * (120 - 105));
    expect(a.cash).toBeCloseTo(100_000 + 300);
  });
  it("selling more than held flips to a short at the new price", () => {
    let a = newAccount(100_000);
    for (const [side, q, p] of [["buy", 10, 100], ["sell", 15, 110]] as const) {
      const r = order(a, "TCS", side, q, p, 1);
      if (!r.ok) throw new Error(r.error);
      a = r.account;
    }
    expect(a.positions.TCS).toEqual({ symbol: "TCS", qty: -5, avg: 110 });
    expect(realisedTotal(a)).toBeCloseTo(100);
  });
  it("rejects bad orders, an unknown price and buying beyond the cash", () => {
    const a = newAccount(1_000);
    expect(order(a, "TCS", "buy", 0, 100, 1).ok).toBe(false);
    expect(order(a, "TCS", "buy", 1.5, 100, 1).ok).toBe(false);
    expect(order(a, "TCS", "buy", 1, null, 1).ok).toBe(false);
    expect(order(a, "TCS", "buy", 100, 100, 1).ok).toBe(false);
  });
  it("open profit leaves out a position whose price is unknown instead of treating it as zero", () => {
    const r = order(newAccount(), "TCS", "buy", 10, 100, 1);
    if (!r.ok) throw new Error(r.error);
    expect(unrealised(r.account, { TCS: 110 })).toEqual({ pnl: 100, unknown: [] });
    expect(unrealised(r.account, { TCS: null })).toEqual({ pnl: 0, unknown: ["TCS"] });
  });
});

describe("layouts and history", () => {
  it("history undoes and redoes, ignores a no-op, and drops redo after a new change", () => {
    const h = new History({ n: 1 });
    h.push({ n: 1 });
    expect(h.canUndo).toBe(false);
    h.push({ n: 2 });
    h.push({ n: 3 });
    expect(h.undo()).toEqual({ n: 2 });
    expect(h.undo()).toEqual({ n: 1 });
    expect(h.undo()).toBeNull();
    expect(h.redo()).toEqual({ n: 2 });
    h.push({ n: 9 });
    expect(h.canRedo).toBe(false);
  });
  it("new indicators get unique ids and colours", () => {
    const a = newIndicator("sma", []);
    const b = newIndicator("sma", [a]);
    expect(b.id).not.toBe(a.id);
    expect(b.color).not.toBe(a.color);
    expect(label(a)).toBe("SMA 20");
    expect(label(newIndicator("macd", []))).toBe("MACD 12 26 9");
  });
  it("sanitize repairs whatever storage hands back", () => {
    const bad = sanitizeLayout({ interval: "7y", type: "pie", indicators: [{ kind: "sma", period: 9999 }, { kind: "nope" }, null], compares: ["tcs", "INFY", 5], hide: { heat: true } }, ids);
    expect(bad.interval).toBe(DEFAULT_LAYOUT.interval);
    expect(bad.type).toBe("candles");
    expect(bad.indicators).toHaveLength(1);
    expect(bad.indicators[0].period).toBe(500);
    expect(bad.compares).toEqual(["INFY"]);
    expect(bad.hide.heat).toBe(true);
    expect(sanitizeLayout(cloneLayout(DEFAULT_LAYOUT), ids)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout(null, ids)).toEqual({ ...DEFAULT_LAYOUT, indicators: [] });
  });
});
