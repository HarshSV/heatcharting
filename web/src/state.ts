/** What a chart looks like, as plain data: easy to save, to undo, and to rebuild. */
export type ChartType = "candles" | "heikin" | "bars" | "line" | "area" | "baseline";

export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: "candles", label: "Candles" },
  { id: "heikin", label: "Heikin Ashi" },
  { id: "bars", label: "Bars (OHLC)" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "baseline", label: "Baseline" },
];

export type IndicatorKind = "volume" | "sma" | "ema" | "vwap" | "bb" | "rsi" | "macd" | "atr" | "delta" | "cvd";

export interface IndicatorSpec {
  id: string;
  kind: IndicatorKind;
  period?: number;
  /** MACD: slow period. Bollinger: standard deviations */
  period2?: number;
  /** MACD: signal period */
  period3?: number;
  color: string;
}

export const INDICATOR_DEFS: Record<IndicatorKind, { label: string; pane: boolean; defaults: Partial<IndicatorSpec> }> = {
  volume: { label: "Volume", pane: false, defaults: {} },
  sma: { label: "Moving average (SMA)", pane: false, defaults: { period: 20 } },
  ema: { label: "Exponential MA (EMA)", pane: false, defaults: { period: 50 } },
  vwap: { label: "VWAP (daily)", pane: false, defaults: {} },
  bb: { label: "Bollinger Bands", pane: false, defaults: { period: 20, period2: 2 } },
  rsi: { label: "RSI", pane: true, defaults: { period: 14 } },
  macd: { label: "MACD", pane: true, defaults: { period: 12, period2: 26, period3: 9 } },
  atr: { label: "ATR", pane: true, defaults: { period: 14 } },
  delta: { label: "Delta (buy - sell)", pane: true, defaults: {} },
  cvd: { label: "Cumulative delta", pane: true, defaults: {} },
};

export const PALETTE = ["#3b82f6", "#f59e0b", "#a855f7", "#22d3ee", "#f43f5e", "#84cc16", "#eab308", "#ec4899"];

export interface Layout {
  interval: string;
  type: ChartType;
  indicators: IndicatorSpec[];
  /** symbols drawn over the main one, rebased to start at the same price */
  compares: string[];
  hide: { heat: boolean; walls: boolean; indicators: boolean; compares: boolean };
  /** trade flow drawn on the chart */
  flow: { footprint: boolean; profile: boolean };
}

export const DEFAULT_LAYOUT: Layout = {
  interval: "5m",
  type: "candles",
  indicators: [{ id: "volume-0", kind: "volume", color: "#64748b" }],
  compares: [],
  hide: { heat: false, walls: false, indicators: false, compares: false },
  flow: { footprint: false, profile: false },
};

export const cloneLayout = (l: Layout): Layout => JSON.parse(JSON.stringify(l)) as Layout;

export function describe(s: IndicatorSpec): string {
  switch (s.kind) {
    case "volume":
      return "Volume";
    case "delta":
      return "Delta";
    case "cvd":
      return "CVD";
    case "vwap":
      return "VWAP";
    case "bb":
      return `BB ${s.period} ${s.period2}`;
    case "macd":
      return `MACD ${s.period} ${s.period2} ${s.period3}`;
    default:
      return `${s.kind.toUpperCase()} ${s.period}`;
  }
}

/** A new indicator with a unique id and the next unused colour. */
export function newIndicator(kind: IndicatorKind, existing: IndicatorSpec[]): IndicatorSpec {
  let n = 0;
  while (existing.some((e) => e.id === `${kind}-${n}`)) n++;
  const color = PALETTE.find((c) => !existing.some((e) => e.color === c)) ?? PALETTE[existing.length % PALETTE.length];
  return { id: `${kind}-${n}`, kind, color, ...INDICATOR_DEFS[kind].defaults } as IndicatorSpec;
}

const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** Make anything read back from storage safe to use: unknown kinds are dropped, numbers are clamped, missing parts fall back to defaults. */
export function sanitizeLayout(x: unknown, knownIntervals: string[]): Layout {
  const o = (x && typeof x === "object" ? x : {}) as Partial<Layout>;
  const kinds = Object.keys(INDICATOR_DEFS);
  const inds: IndicatorSpec[] = [];
  for (const raw of Array.isArray(o.indicators) ? o.indicators : []) {
    if (!raw || typeof raw !== "object" || !kinds.includes((raw as IndicatorSpec).kind)) continue;
    const r = raw as IndicatorSpec;
    const d = INDICATOR_DEFS[r.kind].defaults;
    inds.push({
      id: typeof r.id === "string" ? r.id : `${r.kind}-${inds.length}`,
      kind: r.kind,
      period: d.period != null ? int(r.period, 2, 500, d.period) : undefined,
      period2: d.period2 != null ? int(r.period2, 1, 500, d.period2) : undefined,
      period3: d.period3 != null ? int(r.period3, 1, 500, d.period3) : undefined,
      color: typeof r.color === "string" ? r.color : PALETTE[inds.length % PALETTE.length],
    });
  }
  const types = CHART_TYPES.map((t) => t.id);
  const h = (o.hide ?? {}) as Partial<Layout["hide"]>;
  return {
    interval: typeof o.interval === "string" && knownIntervals.includes(o.interval) ? o.interval : DEFAULT_LAYOUT.interval,
    type: types.includes(o.type as ChartType) ? (o.type as ChartType) : "candles",
    indicators: inds,
    compares: (Array.isArray(o.compares) ? o.compares : []).filter((s): s is string => typeof s === "string" && /^[A-Z0-9&-]{1,20}$/.test(s)).slice(0, 4),
    hide: { heat: h.heat === true, walls: h.walls === true, indicators: h.indicators === true, compares: h.compares === true },
    flow: { footprint: (o.flow as Layout["flow"] | undefined)?.footprint === true, profile: (o.flow as Layout["flow"] | undefined)?.profile === true },
  };
}

/** Undo and redo over whole layouts. A change identical to the current state is not recorded. */
export class History<T> {
  private past: string[] = [];
  private future: string[] = [];
  private current: string;
  constructor(initial: T, private limit = 50) {
    this.current = JSON.stringify(initial);
  }
  push(v: T): void {
    const s = JSON.stringify(v);
    if (s === this.current) return;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = s;
    this.future = [];
  }
  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.current);
    this.current = prev;
    return JSON.parse(prev) as T;
  }
  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.current);
    this.current = next;
    return JSON.parse(next) as T;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
