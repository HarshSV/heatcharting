import { CandlestickSeries, ColorType, CrosshairMode, createChart, type CandlestickData, type UTCTimestamp } from "lightweight-charts";
import * as api from "./api";
import { HeatLayer, toChart } from "./heatmap";
import "./style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const chartEl = $("chart");
const css = (v: string, f: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || f;

const chart = createChart(chartEl, {
  layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted", "#8b98a9"), attributionLogo: false },
  grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.05)" } },
  rightPriceScale: { borderVisible: false },
  timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 12 },
  crosshair: { mode: CrosshairMode.Normal },
});
const series = chart.addSeries(CandlestickSeries, {
  upColor: "#22c55e", downColor: "#ef4444", borderUpColor: "#22c55e", borderDownColor: "#ef4444", wickUpColor: "#22c55e", wickDownColor: "#ef4444",
  priceFormat: { type: "price", precision: 2, minMove: 0.05 },
});
const heat = new HeatLayer($("heat") as HTMLCanvasElement, chart, series);
new ResizeObserver(() => {
  const w = chartEl.clientWidth;
  const h = chartEl.clientHeight;
  chart.applyOptions({ width: w, height: h });
  heat.resize(w, h);
}).observe(chartEl);

let bars: CandlestickData<UTCTimestamp>[] = [];
let feed: { close: () => void } | null = null;
let symbol = "";
let lastLive = 0;
let prevClose: number | null = null;

function setStatus(text: string, tone: "ok" | "warn" | "bad") {
  $("status").textContent = text;
  $("dot").className = tone;
}

function rows(el: HTMLElement, levels: api.Level[], side: "ask" | "bid", max: number) {
  el.innerHTML = levels
    .map(
      ([p, q]) =>
        `<div class="row ${side}"><i style="width:${Math.round((100 * q) / (max || 1))}%"></i><span>${p.toFixed(2)}</span><b>${q.toLocaleString("en-IN")}</b></div>`,
    )
    .join("");
}

function ladder(s: api.Snapshot) {
  const max = Math.max(1, ...s.bids.map((l) => l[1]), ...s.asks.map((l) => l[1]));
  rows($("asks"), [...s.asks].reverse(), "ask", max);
  rows($("bids"), s.bids, "bid", max);
  $("mid").textContent = s.ltp != null ? s.ltp.toFixed(2) : "-";
}

function applyTick(s: api.Snapshot) {
  if (s.ltp == null) return;
  $("ltp").textContent = s.ltp.toFixed(2);
  if (prevClose) {
    const d = s.ltp - prevClose;
    $("chg").textContent = `${d >= 0 ? "+" : ""}${d.toFixed(2)} (${((100 * d) / prevClose).toFixed(2)}%)`;
    $("chg").className = d >= 0 ? "up" : "down";
  }
  const minute = (toChart(s.t) - (toChart(s.t) % 60)) as UTCTimestamp;
  const last = bars[bars.length - 1];
  if (last && last.time === minute) {
    last.high = Math.max(last.high, s.ltp);
    last.low = Math.min(last.low, s.ltp);
    last.close = s.ltp;
    series.update(last);
  } else if (!last || minute > last.time) {
    const b = { time: minute, open: s.ltp, high: s.ltp, low: s.ltp, close: s.ltp } as CandlestickData<UTCTimestamp>;
    bars.push(b);
    series.update(b);
    heat.setBars(bars.map((x) => x.time as number));
  }
}

async function open(sym: string) {
  feed?.close();
  symbol = sym;
  $("sym").textContent = sym;
  $("ltp").textContent = "-";
  $("chg").textContent = "";
  setStatus("Loading...", "warn");
  heat.setSnapshots([]);
  try {
    const [cs, snaps] = await Promise.all([api.candles(sym, 2), api.snapshots(sym, 90)]);
    bars = cs.map((c) => ({ time: toChart(c.time * 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
    series.setData(bars);
    heat.setBars(bars.map((b) => b.time as number));
    const dayStart = bars.length ? bars[bars.length - 1].time - ((bars[bars.length - 1].time as number) % 86400) : 0;
    const before = bars.filter((b) => (b.time as number) < dayStart);
    prevClose = before.length ? before[before.length - 1].close : bars.length ? bars[0].open : null;
    heat.setSnapshots(snaps.snapshots);
    if (snaps.snapshots.length) ladder(snaps.snapshots[snaps.snapshots.length - 1]);
    chart.timeScale().fitContent();
    chart.timeScale().scrollToRealTime();
    $("legend").textContent = snaps.snapshots.length
      ? `${snaps.snapshots.length.toLocaleString("en-IN")} depth snapshots loaded`
      : (snaps.note ?? "No depth recorded yet for this symbol.");
  } catch (e) {
    setStatus(`Could not load: ${(e as Error).message}`, "bad");
    return;
  }
  feed = api.live(
    sym,
    (s) => {
      if (symbol !== sym) return;
      lastLive = Date.now();
      heat.add(s);
      ladder(s);
      applyTick(s);
    },
    (isOpen) => {
      if (!isOpen) setStatus("Reconnecting...", "warn");
    },
  );
}

// the status line: live, or an honest "no data" when the market is closed or the feed is quiet
setInterval(() => {
  if (!symbol) return;
  const quiet = lastLive ? (Date.now() - lastLive) / 1000 : Infinity;
  if (quiet < 15) setStatus("Live", "ok");
  else if (lastLive) setStatus(`No update for ${Math.round(quiet)}s`, "warn");
  else setStatus("Waiting for the feed (market closed? showing the last recorded session)", "warn");
}, 1000);

// search box
let timer = 0;
const q = $("q") as HTMLInputElement;
const results = $("results");
q.addEventListener("input", () => {
  clearTimeout(timer);
  const text = q.value.trim();
  if (!text) {
    results.hidden = true;
    return;
  }
  timer = window.setTimeout(async () => {
    const found = await api.search(text).catch(() => []);
    results.innerHTML = found.map((c) => `<li data-s="${c.symbol}"><b>${c.symbol}</b><span>${c.name}</span></li>`).join("");
    results.hidden = !found.length;
  }, 200);
});
results.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (!li) return;
  results.hidden = true;
  q.value = "";
  history.replaceState(null, "", `#${li.dataset.s}`);
  void open(li.dataset.s!);
});
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter") (results.querySelector("li") as HTMLElement | null)?.click();
});
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".search")) results.hidden = true;
});

void api
  .health()
  .then((h) => {
    if (!h.angel_configured) setStatus("Angel One credentials are missing: copy .env.example to .env and fill it in", "bad");
  })
  .catch(() => setStatus("The server is not reachable", "bad"));
void open(location.hash.slice(1).toUpperCase() || "RELIANCE");
