import type { IChartApi, ISeriesApi, Logical } from "lightweight-charts";
import type { Level, Snapshot } from "./api";

/** The chart shows times in IST by shifting UTC seconds. All chart times pass through toChart(). */
export const IST_SECONDS = 19800;
export const toChart = (ms: number) => Math.floor(ms / 1000) + IST_SECONDS;

const BID = [20, 184, 166]; // teal
const ASK = [244, 114, 70]; // orange
const MAX_HOLD_MS = 120_000; // a snapshot is drawn until the next one, but never longer than this (a market pause is not liquidity)

/** Colour strength 0..1 for a resting quantity against the largest one in view (log scale, so thin and heavy both show). */
export function strength(qty: number, max: number): number {
  if (!(qty > 0) || !(max > 0)) return 0;
  return Math.min(1, Math.log1p(qty) / Math.log1p(max));
}

/** Paints resting orders behind the candles: one band per price level, from one snapshot to the next. */
export class HeatLayer {
  private ctx: CanvasRenderingContext2D;
  private snaps: Snapshot[] = [];
  private barTimes: number[] = []; // chart seconds of the candles, oldest first
  private tick = 0.05;
  private dirty = true;

  constructor(
    private canvas: HTMLCanvasElement,
    private chart: IChartApi,
    private series: ISeriesApi<"Candlestick">,
  ) {
    this.ctx = canvas.getContext("2d")!;
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.invalidate());
    setInterval(() => this.dirty && this.draw(), 150);
  }

  setBars(times: number[]) {
    this.barTimes = times;
    this.invalidate();
  }
  setSnapshots(s: Snapshot[]) {
    this.snaps = s;
    this.invalidate();
  }
  add(s: Snapshot) {
    this.snaps.push(s);
    if (this.snaps.length > 40_000) this.snaps.splice(0, 5_000);
    this.invalidate();
  }
  setTick(t: number) {
    this.tick = t;
    this.invalidate();
  }
  invalidate() {
    this.dirty = true;
  }

  resize(w: number, h: number) {
    const r = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * r);
    this.canvas.height = Math.round(h * r);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(r, 0, 0, r, 0, 0);
    this.invalidate();
  }

  /** Fractional logical index of a time: the candle's position plus the part of the minute that has passed. */
  private logical(sec: number): number | null {
    const b = this.barTimes;
    if (!b.length) return null;
    let lo = 0;
    let hi = b.length - 1;
    if (sec >= b[hi]) return hi + (sec - b[hi]) / 60;
    if (sec < b[0]) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (b[mid] <= sec) lo = mid;
      else hi = mid - 1;
    }
    return lo + (sec - b[lo]) / 60;
  }

  draw() {
    this.dirty = false;
    const { ctx } = this;
    const w = parseFloat(this.canvas.style.width) || 0;
    const h = parseFloat(this.canvas.style.height) || 0;
    ctx.clearRect(0, 0, w, h);
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (!range || !this.snaps.length) return;

    // snapshots in view, and the largest quantity among them (colour scale)
    const visible: Snapshot[] = [];
    let max = 0;
    for (const s of this.snaps) {
      const l = this.logical(toChart(s.t));
      if (l == null || l < range.from - 5 || l > range.to + 5) continue;
      visible.push(s);
      for (const side of [s.bids, s.asks]) for (const lv of side) max = Math.max(max, lv[1]);
    }
    if (!max) return;

    const half = this.tick / 2;
    for (let i = 0; i < visible.length; i++) {
      const s = visible[i];
      const next = visible[i + 1];
      const t0 = s.t;
      const t1 = next ? Math.min(next.t, t0 + MAX_HOLD_MS) : t0 + 1500;
      const l0 = this.logical(toChart(t0));
      const l1 = this.logical(toChart(t1));
      if (l0 == null || l1 == null) continue;
      const x0 = this.chart.timeScale().logicalToCoordinate(l0 as Logical);
      const x1 = this.chart.timeScale().logicalToCoordinate(l1 as Logical);
      if (x0 == null || x1 == null) continue;
      const width = Math.max(1, x1 - x0);
      this.paint(s.bids, BID, x0, width, half, max);
      this.paint(s.asks, ASK, x0, width, half, max);
    }
  }

  private paint(levels: Level[], rgb: number[], x: number, width: number, half: number, max: number) {
    for (const [price, qty] of levels) {
      const yTop = this.series.priceToCoordinate(price + half);
      const yBot = this.series.priceToCoordinate(price - half);
      if (yTop == null || yBot == null) continue;
      const a = 0.12 + 0.78 * strength(qty, max);
      this.ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
      this.ctx.fillRect(x, yTop, width + 0.5, Math.max(1.5, yBot - yTop));
    }
  }
}
