import * as api from "./api";
import type { Alert } from "./alerts";
import { addSymbol, pctText, removeSymbol } from "./ranges";
import type { ChartView } from "./view";

export interface DockApp {
  active(): ChartView;
  openSymbol(symbol: string): void;
  alerts(): Alert[];
  removeAlert(id: string): void;
  watch(): string[];
  setWatch(list: string[]): void;
}

const SV = (inner: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const PANELS: { id: string; title: string; icon: string }[] = [
  { id: "book", title: "Order book and walls", icon: SV('<path d="M4 6h10M4 10h14M4 14h8M4 18h12"/>') },
  { id: "watch", title: "Watchlist", icon: SV('<path d="M4 6h16M4 12h16M4 18h10"/><path d="M18 15l2 2 3-4" />') },
  { id: "alerts", title: "Alerts", icon: SV('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>') },
  { id: "data", title: "Data window", icon: SV('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 9v11"/>') },
  { id: "objects", title: "Objects on the chart", icon: SV('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>') },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const px = (n: number | null | undefined, d = 2) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "-");
const vol = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-IN") : "-");
const cls = (n: number | null | undefined) => (typeof n === "number" ? (n >= 0 ? "up" : "down") : "");

const KEY = "heatcharting.dock";

export interface Dock {
  open(id: string | null): void;
  current(): string | null;
  /** something the panels show may have changed */
  refresh(): void;
  /** the crosshair moved */
  hover(): void;
}

export function buildDock(dock: HTMLElement, rail: HTMLElement, app: DockApp): Dock {
  let current: string | null = null;
  const sections = new Map<string, HTMLElement>();
  dock.querySelectorAll<HTMLElement>(".dp").forEach((s) => sections.set(s.dataset.p!, s));
  let quotes: Record<string, api.QuoteRow> = {};
  let quoteErr = "";

  for (const p of PANELS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rb";
    b.dataset.p = p.id;
    b.title = p.title;
    b.setAttribute("aria-label", p.title);
    b.innerHTML = p.icon;
    b.addEventListener("click", () => open(current === p.id ? null : p.id));
    rail.appendChild(b);
  }

  // ---- watchlist
  function renderWatch() {
    const el = sections.get("watch")!;
    const list = app.watch();
    const act = app.active().symbol;
    el.innerHTML = `<h2>Watchlist <small>${list.length} symbols</small></h2>
      <input class="in" id="wadd" placeholder="Add a symbol, press Enter" autocomplete="off" spellcheck="false" />
      ${quoteErr ? `<p class="hint err">${esc(quoteErr)}</p>` : ""}
      <div class="wl">${list.length ? list.map((s) => {
        const q = quotes[s];
        return `<div class="wrow ${s === act ? "cur" : ""}" data-s="${esc(s)}"><b>${esc(s)}</b><span class="px">${px(q?.ltp)}</span><span class="pc ${cls(q?.change_pct)}">${pctText(q?.change_pct)}</span><button class="x" data-rm="${esc(s)}" title="Remove">&times;</button></div>`;
      }).join("") : '<p class="hint">Empty. Add the symbols you follow; prices refresh every few seconds.</p>'}</div>`;
    el.querySelector("#wadd")!.addEventListener("keydown", async (e) => {
      if ((e as KeyboardEvent).key !== "Enter") return;
      const input = e.target as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;
      const found = await api.search(text).catch(() => []);
      const hit = found.find((c) => c.symbol.toUpperCase() === text.toUpperCase()) ?? found[0];
      if (hit) {
        app.setWatch(addSymbol(app.watch(), hit.symbol));
        pollWatch();
      }
      input.value = "";
    });
    el.querySelectorAll<HTMLElement>(".wrow").forEach((r) => r.addEventListener("click", (e) => {
      const rm = (e.target as HTMLElement).closest("[data-rm]") as HTMLElement | null;
      if (rm) {
        app.setWatch(removeSymbol(app.watch(), rm.dataset.rm!));
        renderWatch();
        return;
      }
      app.openSymbol(r.dataset.s!);
    }));
  }
  async function pollWatch() {
    if (current !== "watch") return;
    const list = app.watch();
    if (!list.length) return renderWatch();
    try {
      quotes = { ...quotes, ...(await api.quotes(list)) };
      quoteErr = "";
    } catch (e) {
      quoteErr = `Prices unavailable: ${(e as Error).message}`;
    }
    if (current === "watch" && !(document.activeElement as HTMLElement | null)?.matches("#wadd")) renderWatch();
  }

  // ---- alerts
  function renderAlerts() {
    const el = sections.get("alerts")!;
    const list = app.alerts();
    el.innerHTML = `<h2>Alerts <small>${list.filter((a) => a.triggered == null).length} waiting</small></h2>
      ${list.length ? list.map((a) => `<div class="arow ${a.triggered ? "done" : ""}" data-s="${esc(a.symbol)}"><b>${esc(a.symbol)}</b><span>${a.dir === "above" ? "&#9650;" : "&#9660;"} ${px(a.price)}</span><em>${a.triggered ? "triggered" : "waiting"}</em><button class="x" data-rm="${esc(a.id)}" title="Remove">&times;</button></div>`).join("") : '<p class="hint">None. Add one from the bell in the toolbar.</p>'}
      <p class="hint">Alerts are checked in this page, so they fire only while it is open.</p>`;
    el.querySelectorAll<HTMLElement>(".arow").forEach((r) => r.addEventListener("click", (e) => {
      const rm = (e.target as HTMLElement).closest("[data-rm]") as HTMLElement | null;
      if (rm) {
        app.removeAlert(rm.dataset.rm!);
        renderAlerts();
        return;
      }
      app.openSymbol(r.dataset.s!);
    }));
  }

  // ---- data window
  function renderData() {
    const el = sections.get("data")!;
    const v = app.active();
    const w = v.dataWindow;
    const b = w.bar;
    const q = quotes[v.symbol];
    const chg = b && w.prevClose != null ? b.close - w.prevClose : null;
    const row = (k: string, val: string, c = "") => `<div class="kv"><span>${k}</span><b class="${c}">${val}</b></div>`;
    el.innerHTML = `<h2>Data window <small>${esc(w.symbol || "-")} &middot; ${esc(w.interval)}</small></h2>
      <h5>${w.live ? "Latest bar" : "Under the cursor"}</h5>
      ${b ? row("Time", new Date(b.time * 1000).toISOString().replace("T", " ").slice(0, 16)) + row("Open", px(b.open)) + row("High", px(b.high)) + row("Low", px(b.low)) + row("Close", px(b.close)) + (chg != null ? row("Change", `${chg >= 0 ? "+" : ""}${px(chg)}`, cls(chg)) : "") + row("Volume", vol(b.volume ?? null)) : '<p class="hint">No bars yet.</p>'}
      ${w.values.length ? `<h5>Indicators</h5>${w.values.map((x) => `<div class="kv"><span style="color:${x.color}">${esc(x.label)}</span><b>${px(x.value)}</b></div>`).join("")}` : ""}
      <h5>Today</h5>
      ${q ? row("Last", px(q.ltp)) + row("Previous close", px(q.prev_close)) + row("Change", pctText(q.change_pct), cls(q.change_pct)) + row("Day high", px(q.high)) + row("Day low", px(q.low)) + row("Volume", vol(q.volume)) + row("Upper circuit", px(q.upper_circuit)) + row("Lower circuit", px(q.lower_circuit)) + row("52-week high", px(q.week52_high)) + row("52-week low", px(q.week52_low)) : '<p class="hint">Quote not loaded yet.</p>'}`;
  }
  async function pollData() {
    if (current !== "data") return;
    const sym = app.active().symbol;
    if (!sym) return;
    try {
      quotes = { ...quotes, ...(await api.quotes([sym])) };
    } catch {
      /* the bar part still works without a quote */
    }
    if (current === "data") renderData();
  }

  // ---- objects
  function renderObjects() {
    const el = sections.get("objects")!;
    const v = app.active();
    const list = v.objects();
    const nice: Record<string, string> = { trend: "Trend line", ray: "Ray", hline: "Horizontal line", vline: "Vertical line", rect: "Rectangle", fib: "Fibonacci", text: "Text" };
    el.innerHTML = `<h2>Objects <small>${list.length}</small></h2>
      ${list.length ? list.map((o) => `<div class="orow" data-id="${esc(o.id)}" data-k="${o.kind}"><i style="background:${o.color}"></i><span>${esc(o.kind === "drawing" ? nice[o.label.split(":")[0]] ?? o.label : o.label)}</span><em>${o.kind}</em><button class="x" data-rm="${esc(o.id)}" title="Remove">&times;</button></div>`).join("") : '<p class="hint">Nothing on this chart yet. Draw with the tools on the left or add an indicator.</p>'}`;
    el.querySelectorAll<HTMLElement>(".orow").forEach((r) => r.addEventListener("click", (e) => {
      const id = r.dataset.id!;
      const kind = r.dataset.k;
      if ((e.target as HTMLElement).closest("[data-rm]")) {
        if (kind === "drawing") v.deleteDrawing(id);
        else if (kind === "indicator") v.removeIndicator(id);
        else v.setCompares(v.layout.compares.filter((c) => c !== id));
        renderObjects();
      } else if (kind === "drawing") v.selectDrawing(id);
    }));
  }

  function renderCurrent() {
    if (current === "watch") renderWatch();
    else if (current === "alerts") renderAlerts();
    else if (current === "data") renderData();
    else if (current === "objects") renderObjects();
  }

  function open(id: string | null) {
    current = id && sections.has(id) ? id : null;
    localStorage.setItem(KEY, JSON.stringify(current));
    dock.hidden = current == null;
    sections.forEach((s, k) => (s.hidden = k !== current));
    rail.querySelectorAll<HTMLElement>(".rb").forEach((b) => b.classList.toggle("on", b.dataset.p === current));
    renderCurrent();
    if (current === "watch") void pollWatch();
    if (current === "data") void pollData();
    window.dispatchEvent(new Event("resize")); // the charts take the room the dock gave back
  }

  window.setInterval(() => void pollWatch(), 4000);
  window.setInterval(() => void pollData(), 5000);

  let saved: string | null = "book";
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '"book"');
  } catch {
    saved = "book";
  }
  open(saved);

  return {
    open,
    current: () => current,
    refresh: () => {
      if (current === "alerts" || current === "objects" || current === "watch") renderCurrent();
    },
    hover: () => {
      if (current === "data") renderData();
    },
  };
}
