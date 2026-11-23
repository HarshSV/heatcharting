import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";

/** Maps between times and positions on a chart whose x axis counts bars. Between bars it interpolates by the bar length; past either end it
 * carries on at the bar length, so a drawing can sit in the future or before the first bar. Shared by the heat, flow and drawing layers. */
export class TimeMap {
  barTimes: number[] = [];
  barSec = 300;

  set(times: number[], sec: number) {
    this.barTimes = times;
    this.barSec = sec;
  }

  /** Fractional bar index of a chart time (null when there are no bars). */
  logical(sec: number): number | null {
    const b = this.barTimes;
    if (!b.length) return null;
    const last = b.length - 1;
    if (sec >= b[last]) return last + (sec - b[last]) / this.barSec;
    if (sec < b[0]) return (sec - b[0]) / this.barSec;
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (b[mid] <= sec) lo = mid;
      else hi = mid - 1;
    }
    return lo + Math.min(1, (sec - b[lo]) / this.barSec);
  }

  /** The inverse of logical(). */
  timeAt(idx: number): number | null {
    const b = this.barTimes;
    if (!b.length) return null;
    const last = b.length - 1;
    if (idx <= 0) return b[0] + idx * this.barSec;
    if (idx >= last) return b[last] + (idx - last) * this.barSec;
    const i = Math.floor(idx);
    return b[i] + (idx - i) * this.barSec;
  }
}

/** A cheap fingerprint of the vertical price scale. It changes when the user drags or zooms the price axis, which the chart does not announce. */
export function priceSignature(series: ISeriesApi<SeriesType> | null, height: number): string {
  if (!series) return "";
  const a = series.coordinateToPrice(0);
  const b = series.coordinateToPrice(height);
  return `${a == null ? "" : (a as number).toFixed(4)}|${b == null ? "" : (b as number).toFixed(4)}`;
}

export function paneHeight(chart: IChartApi, fallback: number): number {
  return chart.panes()[0]?.getHeight() ?? fallback;
}
