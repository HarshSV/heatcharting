import type { IChartApi, ISeriesApi, Logical, SeriesType } from "lightweight-charts";
import { aggregate, profile, rowStep, totals, type FlowEvent } from "./flow";
import { TimeMap, paneHeight, priceSignature } from "./timemap";

const BUY = "20,184,166";
const SELL = "244,114,70";
const MIN_BAR_PX = 46; // below this a bar is too narrow to print numbers in

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** Trade flow on the chart: the footprint (sell x buy at every price inside each bar) and the volume profile (volume at price over what is in view). */
export class FlowLayer {
  private ctx: CanvasRenderingContext2D;
  private events: FlowEvent[] = [];
  private dirty = true;
  private sig = "";
  private series: ISeriesApi<SeriesType> | null = null;
  private tick = 0.05;
  private footprint = false;
  private profileOn = false;
  private cutoff: number | null = null;
  private cache: { key: string; map: ReturnType<typeof aggregate> } | null = null;

  constructor(private canvas: HTMLCanvasElement, private chart: IChartApi, private tm: TimeMap) {
    this.ctx = canvas.getContext("2d")!;
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.invalidate());
    window.setInterval(() => {
      const s = priceSignature(this.series, paneHeight(this.chart, this.h));
      if (s !== this.sig) {
        this.sig = s;
        this.dirty = true;
      }
      if (this.dirty) this.draw();
    }, 150);
  }

  private get w() {
    return parseFloat(this.canvas.style.width) || 0;
  }
  private get h() {
    return parseFloat(this.canvas.style.height) || 0;
  }

  setSeries(s: ISeriesApi<SeriesType> | null) {
    this.series = s;
    this.invalidate();
  }
  setEvents(e: FlowEvent[]) {
    this.events = e;
    this.cache = null;
    this.invalidate();
  }
  add(e: FlowEvent) {
    this.events.push(e);
    this.cache = null;
    this.invalidate();
  }
  get all() {
    return this.events;
  }
  setShow(footprint: boolean, profileOn: boolean) {
    this.footprint = footprint;
    this.profileOn = profileOn;
    this.invalidate();
  }
  setCutoff(ms: number | null) {
    this.cutoff = ms;
    this.cache = null;
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

  draw() {
    this.dirty = false;
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    if ((!this.footprint && !this.profileOn) || !this.series) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const paneH = paneHeight(this.chart, this.h);
    const right = this.w - (this.chart.priceScale("right").width() || 0);
    if (!range) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, right, paneH);
    ctx.clip();
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    if (!this.events.length) {
      ctx.fillStyle = "rgba(139,152,169,0.9)";
      ctx.fillText("No trade flow recorded for this session yet. It is estimated live from the depth feed.", 12, paneH - 18);
      ctx.restore();
      return;
    }
    const top = this.series.coordinateToPrice(0) as number | null;
    const bottom = this.series.coordinateToPrice(paneH) as number | null;
    if (top == null || bottom == null) {
      ctx.restore();
      return;
    }
    const step = rowStep(this.tick, Math.abs(top - bottom) / Math.max(1, paneH));
    if (this.footprint) this.drawFootprint(range.from, range.to, step, paneH);
    if (this.profileOn) this.drawProfile(range.from, range.to, step, right);
    ctx.restore();
  }

  setTick(t: number) {
    this.tick = t;
    this.invalidate();
  }

  private rowH(price: number, step: number): { y: number; h: number } | null {
    const a = this.series!.priceToCoordinate(price + step / 2);
    const b = this.series!.priceToCoordinate(price - step / 2);
    return a == null || b == null ? null : { y: a as number, h: Math.max(1, (b as number) - (a as number)) };
  }

  private drawFootprint(from: number, to: number, step: number, paneH: number) {
    const { ctx } = this;
    const ts = this.chart.timeScale();
    const x0 = ts.logicalToCoordinate(0 as Logical);
    const x1 = ts.logicalToCoordinate(1 as Logical);
    const barPx = x0 != null && x1 != null ? Math.abs((x1 as number) - (x0 as number)) : 0;
    if (barPx < MIN_BAR_PX) {
      ctx.fillStyle = "rgba(139,152,169,0.95)";
      ctx.fillText("Zoom in on the time axis to read the footprint (numbers are sell × buy at each price).", 12, paneH - 18);
      return;
    }
    const key = `${step}|${this.events.length}|${this.cutoff}|${this.tm.barTimes.length}`;
    if (!this.cache || this.cache.key !== key) this.cache = { key, map: aggregate(this.events, this.tm.barTimes, step, this.cutoff) };
    const first = Math.max(0, Math.floor(from));
    const last = Math.min(this.tm.barTimes.length - 1, Math.ceil(to));
    for (let i = first; i <= last; i++) {
      const rows = this.cache.map.get(i);
      if (!rows) continue;
      const cx = ts.logicalToCoordinate(i as Logical) as number | null;
      if (cx == null) continue;
      const half = barPx / 2 - 2;
      for (const [price, c] of rows) {
        const r = this.rowH(price, step);
        if (!r || r.y > paneH || r.y + r.h < 0) continue;
        const dom = c.buy > c.sell * 3 ? BUY : c.sell > c.buy * 3 ? SELL : "148,163,184";
        const strong = c.buy > c.sell * 3 || c.sell > c.buy * 3;
        ctx.fillStyle = `rgba(${dom},${strong ? 0.35 : 0.12})`;
        ctx.fillRect(cx - half, r.y, half * 2, r.h - 1);
        if (r.h >= 11) {
          ctx.fillStyle = "rgba(230,237,246,0.95)";
          ctx.textAlign = "center";
          ctx.fillText(`${k(c.sell)} × ${k(c.buy)}`, cx, r.y + r.h / 2);
          ctx.textAlign = "start";
        }
      }
      // the bar's total delta under its lowest row
      const t = totals(rows);
      const lowest = Math.min(...rows.keys());
      const rl = this.rowH(lowest, step);
      if (rl && t.delta !== 0 && rl.y + rl.h + 10 < paneH) {
        ctx.fillStyle = t.delta > 0 ? `rgb(${BUY})` : `rgb(${SELL})`;
        ctx.textAlign = "center";
        ctx.fillText(`Δ ${t.delta > 0 ? "+" : ""}${k(t.delta)}`, cx, rl.y + rl.h + 9);
        ctx.textAlign = "start";
      }
    }
  }

  private drawProfile(from: number, to: number, step: number, right: number) {
    const { ctx } = this;
    const t0 = this.tm.timeAt(Math.max(0, from));
    const t1 = this.tm.timeAt(Math.min(this.tm.barTimes.length + 5, to));
    if (t0 == null || t1 == null) return;
    const p = profile(this.events, t0, t1, step, this.cutoff);
    if (!p.rows.length) return;
    const maxW = Math.min(180, this.w * 0.22);
    for (const row of p.rows) {
      const r = this.rowH(row.price, step);
      if (!r) continue;
      const total = Math.max(1, row.total);
      const w = (row.total / p.max) * maxW;
      const wb = (row.buy / total) * w;
      const ws = (row.sell / total) * w;
      const wo = w - wb - ws;
      let x = right - 4;
      ctx.fillStyle = `rgba(${BUY},0.55)`;
      ctx.fillRect(x - wb, r.y, wb, Math.max(1, r.h - 1));
      x -= wb;
      ctx.fillStyle = `rgba(${SELL},0.55)`;
      ctx.fillRect(x - ws, r.y, ws, Math.max(1, r.h - 1));
      x -= ws;
      ctx.fillStyle = "rgba(148,163,184,0.45)";
      ctx.fillRect(x - wo, r.y, wo, Math.max(1, r.h - 1));
      if (row.price === p.poc) {
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 1.2;
        ctx.strokeRect(right - 4 - w, r.y, w, Math.max(1, r.h - 1));
      }
    }
  }
}
