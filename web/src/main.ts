import { CandlestickSeries, ColorType, CrosshairMode, createChart, type CandlestickData, type UTCTimestamp } from "lightweight-charts";
import * as api from "./api";
import { HeatLayer, toChart } from "./heatmap";
import { DEFAULTS, clampOptions, wallLine, type HeatOptions } from "./scale";
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

let wallEvents: api.WallEvent[] = [];
function renderWalls() {
  const el = $("wallLog");
  if (!wallEvents.length) {
    el.innerHTML = '<li class="empty">None yet. A wall is an order several times the usual size.</li>';
    return;
  }
  el.innerHTML = [...wallEvents]
    .slice(-15)
    .reverse()
    .map((e) => {
      const t = new Date((Math.floor(e.t / 1000) + 19800) * 1000).toISOString().slice(11, 19);
      return `<li class="${e.kind} ${e.side}"><time>${t}</time>${wallLine(e)}</li>`;
    })
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

// candles come from Angel's REST API, which rate-limits; the live feed does not depend on them, so a failure retries quietly
async function loadBars(sym: string, attempt: number) {
  try {
    const cs = await api.candles(sym, 2);
    if (symbol !== sym) return;
    bars = cs.map((c) => ({ time: toChart(c.time * 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
    series.setData(bars);
    heat.setBars(bars.map((b) => b.time as number));
    const dayStart = bars.length ? (bars[bars.length - 1].time as number) - ((bars[bars.length - 1].time as number) % 86400) : 0;
    const before = bars.filter((b) => (b.time as number) < dayStart);
    prevClose = before.length ? before[before.length - 1].close : bars.length ? bars[0].open : null;
    chart.timeScale().fitContent();
    chart.timeScale().scrollToRealTime();
  } catch (e) {
    if (symbol !== sym) return;
    $("legend").textContent = `Candles unavailable (${(e as Error).message}). Retrying...`;
    if (attempt < 6) setTimeout(() => void loadBars(sym, attempt + 1), 4000 * (attempt + 1));
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
  let snaps: Awaited<ReturnType<typeof api.snapshots>>;
  try {
    snaps = await api.snapshots(sym, 90);
  } catch (e) {
    setStatus(`Could not load: ${(e as Error).message}`, "bad");
    return;
  }
  heat.setSnapshots(snaps.snapshots);
  wallEvents = await api.walls(sym, 90).catch(() => []);
  heat.setEvents(wallEvents);
  renderWalls();
  if (snaps.snapshots.length) ladder(snaps.snapshots[snaps.snapshots.length - 1]);
  $("legend").textContent = snaps.snapshots.length
    ? `${snaps.snapshots.length.toLocaleString("en-IN")} depth snapshots loaded`
    : (snaps.note ?? "No depth recorded yet for this symbol.");
  void loadBars(sym, 0);
  feed = api.live(
    sym,
    {
      snap: (s) => {
        if (symbol !== sym) return;
        lastLive = Date.now();
        heat.add(s);
        ladder(s);
        applyTick(s);
      },
      wall: (w) => {
        if (symbol !== sym) return;
        if (wallEvents.some((x) => x.t === w.t && x.kind === w.kind && x.side === w.side && x.price === w.price)) return; // never list one event twice
        wallEvents.push(w);
        heat.addEvent(w);
        renderWalls();
      },
    },
    (isOpen) => {
      if (!isOpen) setStatus("Reconnecting...", "warn");
    },
  );
}

// heat controls (kept in this browser)
const KEY = "heatcharting.heat";
let opts: HeatOptions = DEFAULTS;
try {
  opts = clampOptions(JSON.parse(localStorage.getItem(KEY) ?? "null"));
} catch {
  opts = DEFAULTS;
}
const qtyOf = (v: number) => (v <= 0 ? 0 : Math.round(10 ** (v / 20))); // slider 0..100 -> 0 .. 100,000 shares, steps grow by 10x every 20 notches
const sliderOf = (q: number) => (q <= 0 ? 0 : Math.round(20 * Math.log10(q)));
const panel = $("toolsPanel");
function showOptions() {
  ($("opacity") as HTMLInputElement).value = String(Math.round(opts.opacity * 100));
  ($("minQty") as HTMLInputElement).value = String(sliderOf(opts.minQty));
  ($("walls") as HTMLInputElement).checked = opts.wallsOnly;
  ($("markers") as HTMLInputElement).checked = opts.showWalls;
  $("opVal").textContent = `${Math.round(opts.opacity * 100)}%`;
  $("minVal").textContent = opts.minQty > 0 ? opts.minQty.toLocaleString("en-IN") : "all";
  panel.querySelectorAll<HTMLButtonElement>("[data-scale]").forEach((b) => b.classList.toggle("on", b.dataset.scale === opts.scale));
}
function setOptions(next: HeatOptions) {
  opts = clampOptions(next);
  localStorage.setItem(KEY, JSON.stringify(opts));
  heat.setOptions(opts);
  showOptions();
}
$("toolsBtn").addEventListener("click", () => {
  panel.hidden = !panel.hidden;
  $("toolsBtn").setAttribute("aria-expanded", String(!panel.hidden));
});
panel.querySelectorAll<HTMLButtonElement>("[data-scale]").forEach((b) => b.addEventListener("click", () => setOptions({ ...opts, scale: b.dataset.scale as HeatOptions["scale"] })));
$("opacity").addEventListener("input", (e) => setOptions({ ...opts, opacity: Number((e.target as HTMLInputElement).value) / 100 }));
$("minQty").addEventListener("input", (e) => setOptions({ ...opts, minQty: qtyOf(Number((e.target as HTMLInputElement).value)) }));
$("markers").addEventListener("change", (e) => setOptions({ ...opts, showWalls: (e.target as HTMLInputElement).checked }));
$("walls").addEventListener("change", (e) => setOptions({ ...opts, wallsOnly: (e.target as HTMLInputElement).checked }));
$("reset").addEventListener("click", () => setOptions(DEFAULTS));
setOptions(opts);

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
