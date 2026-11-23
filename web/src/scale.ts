/** Display options for the heat layer, and the pure rules that turn a resting quantity into a colour strength. */
export type Scale = "log" | "linear";

export interface HeatOptions {
  scale: Scale;
  /** 0.1 .. 1: how opaque the brightest band is */
  opacity: number;
  /** hide levels with fewer shares than this (0 shows everything) */
  minQty: number;
  /** show only the unusually large orders */
  wallsOnly: boolean;
}

export const DEFAULTS: HeatOptions = { scale: "log", opacity: 0.9, minQty: 0, wallsOnly: false };

/** "Unusually large" = at or above this percentile of the resting quantities in view. */
export const WALL_PERCENTILE = 0.9;

export function clampOptions(o: Partial<HeatOptions> | null | undefined): HeatOptions {
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    scale: o?.scale === "linear" ? "linear" : "log",
    opacity: n(o?.opacity, 0.1, 1, DEFAULTS.opacity),
    minQty: n(o?.minQty, 0, 1e7, 0),
    wallsOnly: o?.wallsOnly === true,
  };
}

/** Colour strength 0..1 of a quantity against the largest one shown. Log keeps thin and heavy orders both visible; linear makes walls stand out. */
export function strength(qty: number, max: number, scale: Scale): number {
  if (!(qty > 0) || !(max > 0)) return 0;
  const s = scale === "linear" ? qty / max : Math.log1p(qty) / Math.log1p(max);
  return Math.min(1, s);
}

/** The quantity at the given percentile (0..1) of a list; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

/** The smallest quantity that is drawn, given the options and every quantity in view. */
export function drawThreshold(opts: HeatOptions, quantities: number[]): number {
  return Math.max(opts.minQty, opts.wallsOnly ? percentile(quantities, WALL_PERCENTILE) : 0);
}

/** Opacity of a band: a faint floor so thin orders stay visible, up to the chosen opacity for the largest. */
export function alpha(strengthValue: number, opacity: number): number {
  return opacity * (0.15 + 0.85 * strengthValue);
}
