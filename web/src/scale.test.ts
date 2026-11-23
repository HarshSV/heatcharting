import { describe, expect, it } from "vitest";
import { DEFAULTS, alpha, clampOptions, drawThreshold, percentile, shortQty, strength, wallLine } from "./scale";

describe("strength", () => {
  it("is 0 for nothing and 1 for the largest, on both scales", () => {
    for (const scale of ["log", "linear"] as const) {
      expect(strength(0, 100, scale)).toBe(0);
      expect(strength(100, 100, scale)).toBe(1);
    }
  });
  it("log lifts thin orders more than linear does", () => {
    expect(strength(10, 1000, "log")).toBeGreaterThan(strength(10, 1000, "linear"));
  });
  it("never goes past 1 and treats an unknown maximum as nothing", () => {
    expect(strength(500, 100, "linear")).toBe(1);
    expect(strength(5, 0, "log")).toBe(0);
  });
});

describe("thresholds", () => {
  it("percentile picks the value at that rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.9)).toBe(0);
  });
  it("walls only raises the bar to the 90th percentile, a minimum size can raise it further", () => {
    const q = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(drawThreshold(DEFAULTS, q)).toBe(0);
    expect(drawThreshold({ ...DEFAULTS, wallsOnly: true }, q)).toBe(9);
    expect(drawThreshold({ ...DEFAULTS, minQty: 50 }, q)).toBe(50);
    expect(drawThreshold({ ...DEFAULTS, wallsOnly: true, minQty: 50 }, q)).toBe(50);
  });
});

describe("options", () => {
  it("fills in defaults and clamps bad saved values", () => {
    expect(clampOptions(null)).toEqual(DEFAULTS);
    expect(clampOptions({ opacity: 5, minQty: -3, scale: "weird" as never, wallsOnly: "yes" as never })).toEqual({ scale: "log", opacity: 1, minQty: 0, wallsOnly: false, showWalls: true });
    expect(clampOptions({ opacity: Number.NaN }).opacity).toBe(DEFAULTS.opacity);
  });
  it("alpha keeps a faint floor and reaches the chosen opacity", () => {
    expect(alpha(0, 0.8)).toBeCloseTo(0.12);
    expect(alpha(1, 0.8)).toBeCloseTo(0.8);
  });
});

describe("wall labels", () => {
  it("shortens share counts and never invents one", () => {
    expect(shortQty(950)).toBe("950");
    expect(shortQty(4800)).toBe("4.8k");
    expect(shortQty(25_000)).toBe("25k");
    expect(shortQty(1_200_000)).toBe("1.2M");
    expect(shortQty(null)).toBe("?");
  });
  it("writes one line per event", () => {
    expect(wallLine({ kind: "pulled", side: "bid", price: 2477.6, qty: 4800, held_s: 12 })).toBe("bid wall 2477.60 pulled 4.8k after 12s");
    expect(wallLine({ kind: "appeared", side: "ask", price: 2480, qty: 5000 })).toBe("ask wall 2480.00 appeared 5.0k");
  });
});
