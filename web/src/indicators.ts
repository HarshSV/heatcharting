/** Technical indicators as plain functions. Each takes values oldest first and returns an array of the same length; a position with too little
 * history (or a missing input) is null, never 0. */
export type Series = (number | null)[];

export interface Bar {
  time: number; // chart seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}

const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function sma(values: Series, n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (ok(v)) {
      sum += v;
      cnt++;
    }
    const old = i >= n ? values[i - n] : null;
    if (ok(old)) {
      sum -= old;
      cnt--;
    }
    if (i >= n - 1 && cnt === n) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average, seeded with the simple average of the first n values. */
export function ema(values: Series, n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev: number | null = null;
  let seed: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!ok(v)) {
      prev = null;
      seed = [];
      continue;
    }
    if (prev === null) {
      seed.push(v);
      if (seed.length === n) {
        prev = seed.reduce((a, b) => a + b, 0) / n;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Volume-weighted average price, restarting each day. Null while no volume has traded that day. */
export function vwap(bars: Bar[]): Series {
  const out: Series = new Array(bars.length).fill(null);
  let day = -1;
  let pv = 0;
  let vol = 0;
  bars.forEach((b, i) => {
    const d = Math.floor(b.time / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    if (ok(b.volume) && b.volume > 0) {
      pv += ((b.high + b.low + b.close) / 3) * b.volume;
      vol += b.volume;
    }
    if (vol > 0) out[i] = pv / vol;
  });
  return out;
}

export function bollinger(values: Series, n = 20, k = 2): { mid: Series; upper: Series; lower: Series } {
  const mid = sma(values, n);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    const m = mid[i];
    if (m === null) continue;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (values[j]! - m) ** 2;
    const sd = Math.sqrt(ss / n);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}

/** Wilder's relative strength index. */
export function rsi(values: Series, n = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    if (!ok(a) || !ok(b)) return out.map(() => null); // a gap in the input: no honest answer
    const d = b - a;
    if (i <= n) {
      gain += Math.max(d, 0);
      loss += Math.max(-d, 0);
      if (i === n) {
        gain /= n;
        loss /= n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (n - 1) + Math.max(d, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(values: Series, fast = 12, slow = 26, signal = 9): { macd: Series; signal: Series; hist: Series } {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = f.map((v, i) => (v !== null && s[i] !== null ? v - (s[i] as number) : null));
  const sig = ema(line, signal);
  const hist: Series = line.map((v, i) => (v !== null && sig[i] !== null ? v - (sig[i] as number) : null));
  return { macd: line, signal: sig, hist };
}

/** Average true range (Wilder). */
export function atr(bars: Bar[], n = 14): Series {
  const out: Series = new Array(bars.length).fill(null);
  let prev: number | null = null;
  const tr = bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
  for (let i = 0; i < bars.length; i++) {
    if (i === n - 1) {
      prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
      out[i] = prev;
    } else if (i >= n && prev !== null) {
      prev = (prev * (n - 1) + tr[i]) / n;
      out[i] = prev;
    }
  }
  return out;
}

export const closes = (bars: Bar[]): Series => bars.map((b) => b.close);
