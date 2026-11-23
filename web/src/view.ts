import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import * as api from "./api";
import type { Alert } from "./alerts";
import { DrawLayer, type Drawing, type Tool } from "./draw";
import { deltaSeries, barIndex, type FlowEvent } from "./flow";
import { FlowLayer } from "./flowlayer";
import { HeatLayer } from "./heatmap";
import { TimeMap } from "./timemap";
import { atr, bollinger, closes, ema, macd, rsi, sma, vwap, type Bar, type Series } from "./indicators";
import { DEFAULTS, type HeatOptions } from "./scale";
import { cloneLayout, DEFAULT_LAYOUT, describe, INDICATOR_DEFS, newIndicator, type ChartType, type IndicatorKind, type IndicatorSpec, type Layout } from "./state";
import { IST, aggregate, bucketStart, heikinAshi, intervalOf, rebase, toChartSec, type Interval } from "./transform";

export interface ViewHooks {
  status(text: string, tone: "ok" | "warn" | "bad"): void;
  snap(s: api.Snapshot): void;
  wall(w: api.WallEvent): void;
  /** the last price changed (prev is the price before it, null at the first tick) */
  price(symbol: string, price: number, prev: number | null): void;
  /** the user changed something that belongs in the layout */
  changed(): void;
  note(text: string): void;
  /** a drawing tool finished and the tool went back to the cursor */
  tool(t: Tool): void;
}

const UP = "#22c55e";
const DOWN = "#ef4444";
const COMPARE_COLORS = ["#f59e0b", "#22d3ee", "#a855f7", "#ec4899"];

interface IndicatorRun {
  spec: IndicatorSpec;
  series: ISeriesApi<SeriesType>[];
  /** one array per series, aligned with the bars given */
  compute(bars: Bar[]): Series[];
  /** how to build one data point from a value (histograms carry a colour) */
  point(i: number, bars: Bar[], v: number, k: number): Record<string, unknown>;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export class ChartView {
  readonly el: HTMLElement;
  symbol = "";
  layout: Layout = cloneLayout(DEFAULT_LAYOUT);
  lastPrice: number | null = null;
  lastLive = 0;
  private chart: IChartApi;
  private box: HTMLElement;
  private legend: HTMLElement;
  private heat: HeatLayer;
  private flowLayer: FlowLayer;
  private drawLayer: DrawLayer;
  private tm = new TimeMap();
  private flowTimer = 0;
  private main: ISeriesApi<SeriesType> | null = null;
  private raw: Bar[] = [];
  private runs: IndicatorRun[] = [];
  private compareSeries = new Map<string, { series: ISeriesApi<"Line">; bars: Bar[] }>();
  private alertLines: IPriceLine[] = [];
  private alerts: Alert[] = [];
  private feed: { close: () => void } | null = null;
  private timers: number[] = [];
  private heatOpts: HeatOptions = DEFAULTS;
  private replayState = { active: false, i: 0, playing: false, speed: 1, timer: 0 };
  private seq = 0; // guards against answers that arrive after the symbol or interval changed

  constructor(container: HTMLElement, private hooks: ViewHooks) {
    this.el = container;
    container.classList.add("cv");
    container.innerHTML = '<div class="cv-chart"></div><canvas class="cv-heat"></canvas><canvas class="cv-flow"></canvas><canvas class="cv-draw"></canvas><div class="cv-legend"></div>';
    this.box = container.querySelector(".cv-chart") as HTMLElement;
    this.legend = container.querySelector(".cv-legend") as HTMLElement;
    this.chart = createChart(this.box, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: this.css("--muted", "#8b98a9"), attributionLogo: false, panes: { separatorColor: this.css("--line", "#1e2a39") } },
      grid: { vertLines: { color: this.css("--grid-v", "rgba(255,255,255,0.04)") }, horzLines: { color: this.css("--grid-h", "rgba(255,255,255,0.05)") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 12 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    this.heat = new HeatLayer(container.querySelector(".cv-heat") as HTMLCanvasElement, this.chart);
    this.flowLayer = new FlowLayer(container.querySelector(".cv-flow") as HTMLCanvasElement, this.chart, this.tm);
    this.drawLayer = new DrawLayer(container.querySelector(".cv-draw") as HTMLCanvasElement, container, this.chart, this.tm, {
      changed: (list) => this.saveDrawings(list),
      tool: (t) => this.hooks.tool(t),
      askText: () => window.prompt("Text for the note:"),
      ohlcAt: (t) => {
        const i = barIndex(this.raw.map((b) => b.time), t);
        const b = i >= 0 ? this.raw[i] : null;
        return b ? [b.open, b.high, b.low, b.close] : null;
      },
    });
    new ResizeObserver(() => {
      const w = this.box.clientWidth;
      const h = this.box.clientHeight;
      this.chart.applyOptions({ width: w, height: h });
      this.heat.resize(w, h);
      this.flowLayer.resize(w, h);
      this.drawLayer.resize(w, h);
    }).observe(this.box);
    this.chart.subscribeCrosshairMove((p) => this.updateLegend(p.seriesData as Map<ISeriesApi<SeriesType>, unknown>));
    this.timers.push(window.setInterval(() => void this.refreshBars(), 60_000));
  }

  private css(v: string, f: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || f;
  }

  get interval(): Interval {
    return intervalOf(this.layout.interval);
  }

  // ------------------------------------------------------------------ symbol, interval, layout
  async setSymbol(sym: string) {
    this.stopReplay();
    this.feed?.close();
    this.symbol = sym;
    this.lastPrice = null;
    this.lastLive = 0;
    const my = ++this.seq;
    this.hooks.status("Loading...", "warn");
    this.heat.setSnapshots([]);
    this.heat.setEvents([]);
    this.flowLayer.setEvents([]);
    this.drawLayer.setDrawings(this.loadDrawings(sym));
    let snaps: Awaited<ReturnType<typeof api.snapshots>>;
    try {
      snaps = await api.snapshots(sym, 90);
    } catch (e) {
      this.hooks.status(`Could not load: ${(e as Error).message}`, "bad");
      return;
    }
    if (my !== this.seq) return;
    this.heat.setSnapshots(snaps.snapshots);
    const events = await api.walls(sym, 90).catch(() => []);
    if (my !== this.seq) return;
    this.heat.setEvents(events);
    this.flowLayer.setEvents(((await api.flow(sym, 120).catch(() => [])) as FlowEvent[]).slice());
    if (my !== this.seq) return;
    this.hooks.note(snaps.snapshots.length ? `${snaps.snapshots.length.toLocaleString("en-IN")} depth snapshots loaded` : (snaps.note ?? "No depth recorded yet for this symbol."));
    this.hooks.snap(snaps.snapshots[snaps.snapshots.length - 1] ?? { t: 0, ltp: null, bids: [], asks: [] });
    for (const e of events) this.hooks.wall(e);
    await this.loadBars(0);
    if (my !== this.seq) return;
    this.connect(my);
  }

  private connect(my: number) {
    const sym = this.symbol;
    this.feed = api.live(
      sym,
      {
        snap: (s) => {
          if (my !== this.seq) return;
          this.lastLive = Date.now();
          this.heat.add(s);
          this.hooks.snap(s);
          if (s.ltp != null) this.onTick(s);
        },
        wall: (w) => {
          if (my !== this.seq) return;
          this.heat.addEvent(w);
          this.hooks.wall(w);
        },
        flow: (f) => {
          if (my !== this.seq) return;
          this.flowLayer.add(f);
          this.scheduleFlowRuns();
        },
      },
      (open) => {
        if (!open && my === this.seq) this.hooks.status("Reconnecting...", "warn");
      },
    );
  }

  /** Re-read the candles (after a change of interval, or quietly every minute for the volume of the bar that is forming). */
  private async loadBars(attempt: number, quiet = false) {
    const my = this.seq;
    const iv = this.interval;
    const sym = this.symbol;
    try {
      const cs = await api.candles(sym, iv.days, iv.angel);
      if (my !== this.seq || iv.id !== this.interval.id) return;
      let bars: Bar[] = cs.map((c) => ({ time: toChartSec(c.time * 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
      if (iv.id === "4h" || iv.id === "W") bars = aggregate(bars, iv);
      const keepLive = quiet && this.raw.length ? this.raw[this.raw.length - 1] : null;
      this.raw = bars;
      if (keepLive && bars.length && keepLive.time > bars[bars.length - 1].time) this.raw.push(keepLive); // a bar born from live ticks that the history has not caught up with
      this.hooks.note(`${sym} · ${iv.label}`);
      this.fullRender(!quiet);
      void this.loadCompares();
    } catch (e) {
      if (my !== this.seq) return;
      if (!quiet) {
        this.hooks.note(`Candles unavailable (${(e as Error).message}). Retrying...`);
        if (attempt < 6) this.timers.push(window.setTimeout(() => void this.loadBars(attempt + 1), 4000 * (attempt + 1)));
      }
    }
  }
  private refreshBars() {
    if (this.symbol && !this.replayState.active) return this.loadBars(0, true);
  }

  async setInterval(id: string) {
    if (this.layout.interval === id) return;
    this.stopReplay();
    this.layout.interval = id;
    this.raw = [];
    this.seq++; // answers for the old interval no longer count
    this.fullRender(false);
    this.hooks.changed();
    const my = this.seq;
    this.feed?.close();
    await this.loadBars(0);
    if (my === this.seq) this.connect(my);
  }

  setType(t: ChartType) {
    this.layout.type = t;
    this.rebuildMain();
    this.fullRender(false);
    this.hooks.changed();
  }

  setIndicators(list: IndicatorSpec[]) {
    this.layout.indicators = list;
    this.rebuildIndicators();
    this.fullRender(false);
    this.hooks.changed();
  }

  addIndicator(kind: IndicatorKind) {
    this.setIndicators([...this.layout.indicators, newIndicator(kind, this.layout.indicators)]);
  }
  removeIndicator(id: string) {
    this.setIndicators(this.layout.indicators.filter((i) => i.id !== id));
  }
  updateIndicator(id: string, patch: Partial<IndicatorSpec>) {
    const clean: Partial<IndicatorSpec> = { ...patch };
    for (const k of ["period", "period2", "period3"] as const) if (k in clean) clean[k] = Math.min(500, Math.max(1, Math.round(Number(clean[k]) || 1)));
    this.setIndicators(this.layout.indicators.map((i) => (i.id === id ? { ...i, ...clean } : i)));
  }

  setCompares(list: string[]) {
    this.layout.compares = list;
    for (const [s, c] of this.compareSeries) {
      if (!list.includes(s)) {
        this.chart.removeSeries(c.series);
        this.compareSeries.delete(s);
      }
    }
    void this.loadCompares();
    this.hooks.changed();
  }

  setHide(hide: Partial<Layout["hide"]>) {
    this.layout.hide = { ...this.layout.hide, ...hide };
    this.rebuildIndicators();
    this.fullRender(false);
    this.hooks.changed();
  }

  /** Apply a whole saved layout (also used by undo and redo). `silent` skips the change notification. */
  async applyLayout(l: Layout, silent = true) {
    const intervalChanged = l.interval !== this.layout.interval;
    this.layout = cloneLayout(l);
    this.rebuildMain();
    this.rebuildIndicators();
    for (const [s, c] of this.compareSeries) {
      if (!l.compares.includes(s)) {
        this.chart.removeSeries(c.series);
        this.compareSeries.delete(s);
      }
    }
    if (intervalChanged) {
      this.stopReplay();
      this.raw = [];
      this.seq++;
      this.feed?.close();
      this.fullRender(false);
      const my = this.seq;
      await this.loadBars(0);
      if (my === this.seq) this.connect(my);
    } else {
      this.fullRender(false);
      void this.loadCompares();
    }
    if (!silent) this.hooks.changed();
  }

  setHeatOptions(o: HeatOptions) {
    this.heatOpts = o;
    this.heat.setOptions(o);
    this.applyHeatVisibility();
  }
  private applyHeatVisibility() {
    const markers = this.heatOpts.showWalls && !this.layout.hide.walls;
    this.heat.setVisible(this.interval.heat && !this.layout.hide.heat, markers);
  }

  // ------------------------------------------------------------------ drawing
  private visibleRaw(): Bar[] {
    return this.replayState.active ? this.raw.slice(0, this.replayState.i + 1) : this.raw;
  }

  private rebuildMain() {
    if (this.main) {
      this.chart.removeSeries(this.main);
      this.main = null;
    }
    const t = this.layout.type;
    const base = { priceFormat: { type: "price" as const, precision: 2, minMove: 0.05 } };
    if (t === "candles" || t === "heikin") this.main = this.chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, ...base });
    else if (t === "bars") this.main = this.chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, ...base });
    else if (t === "line") this.main = this.chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, ...base });
    else if (t === "area") this.main = this.chart.addSeries(AreaSeries, { lineColor: "#3b82f6", topColor: "rgba(59,130,246,0.35)", bottomColor: "rgba(59,130,246,0.02)", ...base });
    else this.main = this.chart.addSeries(BaselineSeries, { topLineColor: UP, bottomLineColor: DOWN, topFillColor1: "rgba(34,197,94,0.25)", topFillColor2: "rgba(34,197,94,0.02)", bottomFillColor1: "rgba(239,68,68,0.02)", bottomFillColor2: "rgba(239,68,68,0.25)", ...base });
    this.heat.setSeries(this.main);
    this.flowLayer.setSeries(this.main);
    this.drawLayer.setSeries(this.main);
    this.setAlertLines(this.alerts);
  }

  private mainData(bars: Bar[]) {
    const src = this.layout.type === "heikin" ? heikinAshi(bars) : bars;
    const ohlc = this.layout.type === "candles" || this.layout.type === "heikin" || this.layout.type === "bars";
    return src.map((b) => (ohlc ? { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close } : { time: b.time as UTCTimestamp, value: b.close }));
  }

  private makeRun(spec: IndicatorSpec, pane: number): IndicatorRun | null {
    const add = <T extends SeriesType>(def: Parameters<IChartApi["addSeries"]>[0], opts: object, p = 0) => this.chart.addSeries(def, opts as never, p) as unknown as ISeriesApi<T>;
    const line = (color: string, p = 0, w: 1 | 2 = 1) => add(LineSeries, { color, lineWidth: w, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }, p);
    const plain = (i: number, b: Bar[], v: number) => ({ time: b[i].time as UTCTimestamp, value: v });
    const n = spec.period ?? 20;
    switch (spec.kind) {
      case "volume": {
        const s = add(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
        this.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        return { spec, series: [s], compute: (b) => [b.map((x) => (num(x.volume) ? x.volume : null))], point: (i, b, v) => ({ time: b[i].time, value: v, color: b[i].close >= b[i].open ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)" }) };
      }
      case "sma":
        return { spec, series: [line(spec.color)], compute: (b) => [sma(closes(b), n)], point: (i, b, v) => plain(i, b, v) };
      case "ema":
        return { spec, series: [line(spec.color)], compute: (b) => [ema(closes(b), n)], point: (i, b, v) => plain(i, b, v) };
      case "vwap":
        return { spec, series: [line(spec.color)], compute: (b) => [vwap(b)], point: (i, b, v) => plain(i, b, v) };
      case "bb":
        return { spec, series: [line(spec.color), line(spec.color), line(spec.color)], compute: (b) => { const r = bollinger(closes(b), n, spec.period2 ?? 2); return [r.upper, r.mid, r.lower]; }, point: (i, b, v) => plain(i, b, v) };
      case "rsi": {
        const s = line(spec.color, pane, 2);
        s.createPriceLine({ price: 70, color: "rgba(244,63,94,0.5)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
        s.createPriceLine({ price: 30, color: "rgba(34,197,94,0.5)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
        return { spec, series: [s], compute: (b) => [rsi(closes(b), n)], point: (i, b, v) => plain(i, b, v) };
      }
      case "macd": {
        const hist = add(HistogramSeries, { lastValueVisible: false, priceLineVisible: false }, pane);
        const m = line(spec.color, pane, 2);
        const sg = line("#f59e0b", pane, 1);
        return { spec, series: [m, sg, hist], compute: (b) => { const r = macd(closes(b), n, spec.period2 ?? 26, spec.period3 ?? 9); return [r.macd, r.signal, r.hist]; },
          point: (i, b, v, k) => (k === 2 ? { time: b[i].time, value: v, color: v >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)" } : plain(i, b, v)) };
      }
      case "atr":
        return { spec, series: [line(spec.color, pane, 2)], compute: (b) => [atr(b, n)], point: (i, b, v) => plain(i, b, v) };
      case "delta": {
        const s = add(HistogramSeries, { lastValueVisible: false, priceLineVisible: false }, pane);
        return { spec, series: [s], compute: (b) => [deltaSeries(this.flowLayer.all, b.map((x) => x.time), this.interval.sec, this.flowCutoff()).delta],
          point: (i, b, v) => ({ time: b[i].time, value: v, color: v >= 0 ? "rgba(20,184,166,0.7)" : "rgba(244,114,70,0.7)" }) };
      }
      case "cvd":
        return { spec, series: [line(spec.color, pane, 2)], compute: (b) => [deltaSeries(this.flowLayer.all, b.map((x) => x.time), this.interval.sec, this.flowCutoff()).cvd], point: (i, b, v) => plain(i, b, v) };
    }
  }

  private rebuildIndicators() {
    for (const r of this.runs) for (const s of r.series) this.chart.removeSeries(s);
    this.runs = [];
    while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1);
    if (this.layout.hide.indicators) return;
    let pane = 1;
    for (const spec of this.layout.indicators) {
      const isPane = INDICATOR_DEFS[spec.kind].pane;
      const run = this.makeRun(spec, isPane ? pane : 0);
      if (run) {
        this.runs.push(run);
        if (isPane) pane++;
      }
    }
  }

  private fullRender(fit: boolean) {
    if (!this.main) {
      this.rebuildMain();
      this.rebuildIndicators();
    }
    const bars = this.visibleRaw();
    this.main!.setData(this.mainData(bars) as never);
    for (const r of this.runs) {
      const arrays = r.compute(bars);
      r.series.forEach((s, k) => s.setData(arrays[k].flatMap((v, i) => (v === null ? [] : [r.point(i, bars, v, k)])) as never));
    }
    this.heat.setBars(bars.map((b) => b.time), this.interval.sec);
    this.tm.set(bars.map((b) => b.time), this.interval.sec);
    this.heat.setCutoff(this.flowCutoff());
    this.flowLayer.setCutoff(this.flowCutoff());
    this.flowLayer.setShow(this.layout.flow.footprint, this.layout.flow.profile);
    this.drawLayer.invalidate();
    this.applyHeatVisibility();
    this.renderCompares();
    this.updateLegend(new Map());
    if (fit && bars.length) {
      this.chart.timeScale().fitContent();
      this.chart.timeScale().scrollToRealTime();
    }
  }

  // ------------------------------------------------------------------ live ticks
  private onTick(s: api.Snapshot) {
    const price = s.ltp as number;
    const prev = this.lastPrice;
    this.lastPrice = price;
    this.hooks.price(this.symbol, price, prev);
    if (this.replayState.active || !this.raw.length) return;
    const iv = this.interval;
    const start = bucketStart(toChartSec(s.t), iv);
    const last = this.raw[this.raw.length - 1];
    if (last.time === start) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    } else if (start > last.time) {
      this.raw.push({ time: start, open: price, high: price, low: price, close: price, volume: null });
      this.heat.setBars(this.raw.map((b) => b.time), iv.sec);
      this.tm.set(this.raw.map((b) => b.time), iv.sec);
    } else return;
    const bars = this.raw;
    const i = bars.length - 1;
    this.main!.update(this.mainData(bars.slice(-2)).slice(-1)[0] as never);
    for (const r of this.runs) {
      const arrays = r.compute(bars);
      r.series.forEach((ser, k) => {
        const v = arrays[k][i];
        if (v !== null && v !== undefined) ser.update(r.point(i, bars, v, k) as never);
      });
    }
    this.heat.invalidate();
  }

  /** Previous session's close (for the change shown next to the price). Needs at least two days of intraday bars, or two daily bars. */
  prevClose(): number | null {
    const b = this.raw;
    if (b.length < 2) return null;
    if (this.interval.sec >= 86400) return b[b.length - 2].close;
    const day = Math.floor(b[b.length - 1].time / 86400);
    for (let i = b.length - 1; i >= 0; i--) if (Math.floor(b[i].time / 86400) < day) return b[i].close;
    return null;
  }

  // ------------------------------------------------------------------ trade flow and drawings
  /** In replay, nothing after the replay cursor counts. */
  private flowCutoff(): number | null {
    const bars = this.visibleRaw();
    return this.replayState.active && bars.length ? (bars[bars.length - 1].time - IST + this.interval.sec) * 1000 : null;
  }

  /** New flow arrives every second; the delta panes are rebuilt at most about once a second. */
  private scheduleFlowRuns() {
    if (this.flowTimer) return;
    this.flowTimer = window.setTimeout(() => {
      this.flowTimer = 0;
      const bars = this.visibleRaw();
      for (const r of this.runs) {
        if (r.spec.kind !== "delta" && r.spec.kind !== "cvd") continue;
        const arrays = r.compute(bars);
        r.series.forEach((s, k) => s.setData(arrays[k].flatMap((v, i) => (v === null ? [] : [r.point(i, bars, v, k)])) as never));
      }
    }, 1000);
  }

  /** Zoom the time axis around the right edge, so the latest bars stay in view. factor < 1 zooms in. */
  zoom(factor: number) {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    if (!r) return;
    const w = Math.max(6, (r.to - r.from) * factor);
    this.chart.timeScale().setVisibleLogicalRange({ from: r.to - w, to: r.to });
  }
  latest() {
    this.chart.timeScale().scrollToRealTime();
  }

  setFlow(p: Partial<Layout["flow"]>) {
    this.layout.flow = { ...this.layout.flow, ...p };
    this.flowLayer.setShow(this.layout.flow.footprint, this.layout.flow.profile);
    this.hooks.changed();
  }
  get flowCount() {
    return this.flowLayer.all.length;
  }

  private loadDrawings(sym: string): Drawing[] {
    try {
      const v = JSON.parse(localStorage.getItem(`heatcharting.drawings.${sym}`) ?? "[]");
      return Array.isArray(v) ? v.filter((d) => d && typeof d.id === "string" && Array.isArray(d.pts) && d.pts.every((p: { t: unknown; p: unknown }) => num(p.t) && num(p.p))) : [];
    } catch {
      return [];
    }
  }
  private saveDrawings(list: Drawing[]) {
    if (this.symbol) localStorage.setItem(`heatcharting.drawings.${this.symbol}`, JSON.stringify(list));
    this.hooks.tool(this.drawLayer.tool);
  }
  setTool(t: Tool) {
    this.drawLayer.setTool(t);
  }
  get drawState() {
    const d = this.drawLayer;
    return { tool: d.tool, magnet: d.magnet, hidden: d.hidden, count: d.drawings.length, selected: d.selected != null, color: d.currentColor };
  }
  setMagnet(on: boolean) {
    this.drawLayer.magnet = on;
  }
  setDrawingsHidden(h: boolean) {
    this.drawLayer.setHidden(h);
  }
  setDrawingColor(c: string) {
    this.drawLayer.setColor(c);
  }
  clearDrawings() {
    this.drawLayer.clear();
  }
  deleteSelectedDrawing() {
    this.drawLayer.deleteSelected();
  }
  undoDrawing() {
    this.drawLayer.undoDrawing();
  }
  redoDrawing() {
    this.drawLayer.redoDrawing();
  }

  // ------------------------------------------------------------------ compare
  private async loadCompares() {
    const my = this.seq;
    const iv = this.interval;
    for (const sym of this.layout.compares) {
      try {
        const cs = await api.candles(sym, iv.days, iv.angel);
        if (my !== this.seq) return;
        let bars: Bar[] = cs.map((c) => ({ time: toChartSec(c.time * 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
        if (iv.id === "4h" || iv.id === "W") bars = aggregate(bars, iv);
        const have = this.compareSeries.get(sym);
        if (have) have.bars = bars;
        else {
          const color = COMPARE_COLORS[this.compareSeries.size % COMPARE_COLORS.length];
          const series = this.chart.addSeries(LineSeries, { color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, title: sym, priceFormat: { type: "price", precision: 2, minMove: 0.05 } });
          this.compareSeries.set(sym, { series, bars });
        }
      } catch (e) {
        this.hooks.note(`Could not load ${sym} for comparison: ${(e as Error).message}`);
      }
    }
    this.renderCompares();
  }

  private renderCompares() {
    const main = this.visibleRaw();
    for (const [sym, c] of this.compareSeries) {
      const data = this.layout.hide.compares ? [] : rebase(main, c.bars);
      c.series.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
      void sym;
    }
  }

  // ------------------------------------------------------------------ alerts
  setAlertLines(alerts: Alert[]) {
    this.alerts = alerts;
    if (!this.main) return;
    for (const l of this.alertLines) this.main.removePriceLine(l);
    this.alertLines = alerts
      .filter((a) => a.symbol === this.symbol && a.triggered == null)
      .map((a) => this.main!.createPriceLine({ price: a.price, color: "#f59e0b", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `Alert ${a.dir === "above" ? "▲" : "▼"}` }));
  }

  // ------------------------------------------------------------------ replay
  get replay() {
    return { active: this.replayState.active, index: this.replayState.i, total: this.raw.length, playing: this.replayState.playing, speed: this.replayState.speed, time: this.raw[this.replayState.i]?.time ?? null };
  }
  startReplay(index?: number) {
    if (this.raw.length < 20) {
      this.hooks.note("Not enough candles to replay yet.");
      return;
    }
    this.replayState.active = true;
    // by default start at the open of the latest trading day, which is where the recorded depth is
    const lastDay = Math.floor(this.raw[this.raw.length - 1].time / 86400);
    const dayOpen = this.raw.findIndex((b) => Math.floor(b.time / 86400) === lastDay);
    const fallback = Math.max(10, Math.floor(this.raw.length * 0.6));
    this.replayState.i = Math.max(1, Math.min(this.raw.length - 2, index ?? (dayOpen >= 10 ? dayOpen : fallback)));
    this.fullRender(false);
    this.hooks.changed();
  }
  seek(i: number) {
    if (!this.replayState.active) return;
    this.replayState.i = Math.max(1, Math.min(this.raw.length - 1, Math.round(i)));
    this.fullRender(false);
  }
  step(n: number) {
    this.seek(this.replayState.i + n);
    if (this.replayState.i >= this.raw.length - 1) this.pause();
  }
  play(speed: number) {
    if (!this.replayState.active) return;
    this.replayState.speed = speed;
    window.clearInterval(this.replayState.timer);
    this.replayState.playing = true;
    this.replayState.timer = window.setInterval(() => this.step(1), 1000 / speed);
  }
  pause() {
    window.clearInterval(this.replayState.timer);
    this.replayState.playing = false;
    this.hooks.changed();
  }
  stopReplay() {
    if (!this.replayState.active) return;
    this.pause();
    this.replayState.active = false;
    this.fullRender(false);
    this.chart.timeScale().scrollToRealTime();
    this.hooks.changed();
  }

  // ------------------------------------------------------------------ legend, export
  private updateLegend(data: Map<ISeriesApi<SeriesType>, unknown>) {
    const b = this.visibleRaw();
    const m = this.main ? (data.get(this.main) as { open?: number; high?: number; low?: number; close?: number; value?: number } | undefined) : undefined;
    const last = b[b.length - 1];
    const o = m?.open ?? last?.open;
    const h = m?.high ?? last?.high;
    const l = m?.low ?? last?.low;
    const c = m?.close ?? m?.value ?? last?.close;
    const f = (v: number | undefined) => (num(v) ? v.toFixed(2) : "-");
    const up = num(c) && num(o) ? c >= o : true;
    const parts = [`<b>${this.symbol || "-"}</b> <span class="iv">${this.interval.label}</span>`, `<span class="${up ? "up" : "down"}">O ${f(o)} H ${f(h)} L ${f(l)} C ${f(c)}</span>`];
    for (const r of this.runs) {
      const v = data.get(r.series[r.series.length > 1 && r.spec.kind !== "macd" ? 1 : 0]) as { value?: number } | undefined;
      parts.push(`<span class="ind" style="color:${r.spec.color}">${describe(r.spec)}${num(v?.value) ? " " + v.value.toFixed(2) : ""}</span>`);
    }
    for (const [sym] of this.compareSeries) parts.push(`<span class="ind">vs ${sym}</span>`);
    this.legend.innerHTML = parts.join(" ");
  }

  /** The chart and the heat layer as one image. */
  screenshot(): HTMLCanvasElement {
    const shot = this.chart.takeScreenshot();
    const ctx = shot.getContext("2d")!;
    ctx.drawImage(this.heat.element, 0, 0, shot.width, shot.height);
    ctx.drawImage(this.el.querySelector(".cv-flow") as HTMLCanvasElement, 0, 0, shot.width, shot.height);
    ctx.drawImage(this.el.querySelector(".cv-draw") as HTMLCanvasElement, 0, 0, shot.width, shot.height);
    return shot;
  }

  csv(): string {
    const rows = ["time_ist,open,high,low,close,volume"];
    for (const b of this.visibleRaw()) rows.push([new Date(b.time * 1000).toISOString().replace("T", " ").slice(0, 19), b.open, b.high, b.low, b.close, b.volume ?? ""].join(","));
    return rows.join("\n");
  }

  applyTheme() {
    this.chart.applyOptions({
      layout: { textColor: this.css("--muted", "#8b98a9"), panes: { separatorColor: this.css("--line", "#1e2a39") } },
      grid: { vertLines: { color: this.css("--grid-v", "rgba(255,255,255,0.04)") }, horzLines: { color: this.css("--grid-h", "rgba(255,255,255,0.05)") } },
    });
    this.heat.invalidate();
  }

  dispose() {
    this.feed?.close();
    this.timers.forEach((t) => (window.clearInterval(t), window.clearTimeout(t)));
    window.clearInterval(this.replayState.timer);
    this.chart.remove();
  }
}
