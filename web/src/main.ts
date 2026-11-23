import * as api from "./api";
import { directionFor, evaluate, loadAlerts, saveAlerts, type Alert } from "./alerts";
import { loadAccount, newAccount, order, saveAccount, type Account } from "./paper";
import { clampOptions, wallLine, type HeatOptions } from "./scale";
import { DEFAULT_LAYOUT, History, cloneLayout, sanitizeLayout, type Layout } from "./state";
import { INTERVALS, IST } from "./transform";
import { COLORS, TOOLS, type Tool } from "./draw";
import { buildToolbar, type App } from "./toolbar";
import { ChartView } from "./view";
import "./style.css";
import "./toolbar.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ids = INTERVALS.map((i) => i.id);
const KEYS = { heat: "heatcharting.heat", work: "heatcharting.workspace", layouts: "heatcharting.layouts", theme: "heatcharting.theme" };
const DEFAULT_SYMBOLS = ["RELIANCE", "TCS", "INFY", "HDFCBANK"];

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------ state
interface Ctx {
  view: ChartView;
  walls: api.WallEvent[];
  snap: api.Snapshot | null;
  status: { text: string; tone: "ok" | "warn" | "bad" };
  note: string;
  /** the symbol this chart was asked to show (the view's own symbol is set a moment later) */
  want: string;
  history: History<Layout>;
}
interface Workspace {
  grid: number;
  views: { symbol: string; layout: Layout }[];
  active: number;
}

let heatOpts: HeatOptions = clampOptions(read(KEYS.heat, null));
let alerts: Alert[] = loadAlerts();
let account: Account = loadAccount();
let theme: "dark" | "light" = read<string>(KEYS.theme, "dark") === "light" ? "light" : "dark";
let layoutName = "";
let ctxs: Ctx[] = [];
let activeIx = 0;
const gridEl = $("grid");

const active = () => ctxs[activeIx];

// ------------------------------------------------------------------ small UI helpers
let toastTimer = 0;
function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 6000);
}
function beep() {
  try {
    const ac = new AudioContext();
    const o = ac.createOscillator();
    o.frequency.value = 880;
    o.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.18);
  } catch {
    /* no audio available */
  }
}
const setStatus = (c: Ctx, text: string, tone: "ok" | "warn" | "bad") => {
  c.status = { text, tone };
  if (c === active()) showStatus(c);
};
function showStatus(c: Ctx) {
  $("status").textContent = c.status.text;
  $("dot").className = c.status.tone;
}

function rows(el: HTMLElement, levels: api.Level[], side: "ask" | "bid", max: number) {
  el.innerHTML = levels
    .map(([p, q]) => `<div class="row ${side}"><i style="width:${Math.round((100 * q) / (max || 1))}%"></i><span>${p.toFixed(2)}</span><b>${q.toLocaleString("en-IN")}</b></div>`)
    .join("");
}
function showLadder(s: api.Snapshot | null) {
  if (!s || (!s.bids.length && !s.asks.length)) {
    $("asks").innerHTML = "";
    $("bids").innerHTML = "";
    $("mid").textContent = "-";
    return;
  }
  const max = Math.max(1, ...s.bids.map((l) => l[1]), ...s.asks.map((l) => l[1]));
  rows($("asks"), [...s.asks].reverse(), "ask", max);
  rows($("bids"), s.bids, "bid", max);
  $("mid").textContent = s.ltp != null ? s.ltp.toFixed(2) : "-";
}
function showWalls(c: Ctx) {
  const el = $("wallLog");
  if (!c.walls.length) {
    el.innerHTML = '<li class="empty">None yet. A wall is an order several times the usual size.</li>';
    return;
  }
  el.innerHTML = [...c.walls]
    .slice(-15)
    .reverse()
    .map((e) => `<li class="${e.kind} ${e.side}"><time>${new Date((Math.floor(e.t / 1000) + IST) * 1000).toISOString().slice(11, 19)}</time>${wallLine(e)}</li>`)
    .join("");
}
function showQuote(c: Ctx) {
  const v = c.view;
  $("sym").textContent = v.symbol || "-";
  $("ltp").textContent = v.lastPrice != null ? v.lastPrice.toFixed(2) : "-";
  const pc = v.prevClose();
  if (v.lastPrice != null && pc) {
    const d = v.lastPrice - pc;
    $("chg").textContent = `${d >= 0 ? "+" : ""}${d.toFixed(2)} (${((100 * d) / pc).toFixed(2)}%)`;
    $("chg").className = d >= 0 ? "up" : "down";
  } else $("chg").textContent = "";
  $("note").textContent = c.note;
}
function showActive() {
  const c = active();
  showQuote(c);
  showStatus(c);
  showLadder(c.snap);
  showWalls(c);
  ctxs.forEach((x, i) => x.view.el.classList.toggle("active", i === activeIx && ctxs.length > 1));
  toolbar.refresh();
  showReplay();
  refreshTools();
}

// ------------------------------------------------------------------ persistence
function workspace(): Workspace {
  return { grid: ctxs.length, views: ctxs.map((c) => ({ symbol: c.view.symbol, layout: cloneLayout(c.view.layout) })), active: activeIx };
}
const persist = () => localStorage.setItem(KEYS.work, JSON.stringify(workspace()));

// ------------------------------------------------------------------ views
function createView(symbol: string, layout?: Layout): Ctx {
  const el = document.createElement("div");
  gridEl.appendChild(el);
  const c = { walls: [], snap: null, status: { text: "Starting...", tone: "warn" }, note: "", want: symbol } as unknown as Ctx;
  c.view = new ChartView(el, {
    status: (t, tone) => setStatus(c, t, tone),
    snap: (s) => {
      c.snap = s;
      if (c === active()) showLadder(s);
    },
    wall: (w) => {
      if (c.walls.some((x) => x.t === w.t && x.kind === w.kind && x.side === w.side && x.price === w.price)) return; // never list one event twice
      c.walls.push(w);
      if (c === active()) showWalls(c);
    },
    price: (sym, price, prev) => {
      checkAlerts(sym, prev, price);
      if (c === active()) showQuote(c);
    },
    note: (t) => {
      c.note = t;
      if (c === active()) $("note").textContent = t;
    },
    tool: () => {
      if (c === active()) refreshTools();
    },
    changed: () => {
      c.history.push(c.view.layout);
      persist();
      if (c === active()) {
        toolbar.refresh();
        showReplay();
      }
    },
  });
  if (layout) c.view.layout = cloneLayout(layout);
  c.history = new History(c.view.layout);
  c.view.setHeatOptions(heatOpts);
  c.view.setAlertLines(alerts);
  c.view.applyTheme();
  void c.view.applyLayout(c.view.layout).then(() => c.view.setSymbol(symbol)).then(persist);
  persist();
  el.addEventListener("mousedown", () => {
    const i = ctxs.indexOf(c);
    if (i >= 0 && i !== activeIx) {
      activeIx = i;
      persist();
      showActive();
    }
  });
  return c;
}

function setGrid(n: number) {
  while (ctxs.length < n) {
    const used = new Set(ctxs.map((c) => c.view.symbol || c.want));
    ctxs.push(createView(DEFAULT_SYMBOLS.find((s) => !used.has(s)) ?? "RELIANCE", ctxs.length ? { ...cloneLayout(ctxs[0].view.layout), compares: [] } : undefined));
  }
  while (ctxs.length > n) {
    ctxs.pop()!.view.dispose();
    gridEl.lastElementChild?.remove();
  }
  if (activeIx >= ctxs.length) activeIx = 0;
  gridEl.className = `grid g${n}`;
  persist();
  showActive();
}

// ------------------------------------------------------------------ alerts
function checkAlerts(sym: string, prev: number | null, price: number) {
  const hit = evaluate(alerts, sym, prev, price);
  if (!hit.length) return;
  for (const a of hit) {
    a.triggered = Date.now();
    const msg = `${a.symbol} reached ${a.price.toFixed(2)} (${a.dir === "above" ? "rose to" : "fell to"} it)`;
    toast(`Alert: ${msg}`);
    beep();
    if ("Notification" in window && Notification.permission === "granted") new Notification("HeatCharting alert", { body: msg });
  }
  saveAlerts(alerts);
  ctxs.forEach((c) => c.view.setAlertLines(alerts));
  toolbar.refresh();
}

// ------------------------------------------------------------------ the toolbar's view of the app
function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(KEYS.theme, JSON.stringify(theme));
  ctxs.forEach((c) => c.view.applyTheme());
}
const savedLayouts = () => read<Record<string, Workspace>>(KEYS.layouts, {});

const app: App = {
  active: () => active().view,
  views: () => ctxs.map((c) => c.view),
  heatOpts: () => heatOpts,
  setHeatOpts: (o) => {
    heatOpts = clampOptions(o);
    localStorage.setItem(KEYS.heat, JSON.stringify(heatOpts));
    ctxs.forEach((c) => c.view.setHeatOptions(heatOpts));
  },
  alerts: () => alerts,
  addAlert: (price) => {
    const v = active().view;
    alerts.push({ id: `${Date.now()}-${Math.round(Math.random() * 1e4)}`, symbol: v.symbol, price, dir: directionFor(price, v.lastPrice), created: Date.now() });
    saveAlerts(alerts);
    ctxs.forEach((c) => c.view.setAlertLines(alerts));
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  },
  removeAlert: (id) => {
    alerts = alerts.filter((a) => a.id !== id);
    saveAlerts(alerts);
    ctxs.forEach((c) => c.view.setAlertLines(alerts));
  },
  canUndo: () => active().history.canUndo,
  canRedo: () => active().history.canRedo,
  undo: () => {
    const c = active();
    const l = c.history.undo();
    if (l)
      void c.view.applyLayout(sanitizeLayout(l, ids)).then(() => {
        persist();
        toolbar.refresh();
      });
  },
  redo: () => {
    const c = active();
    const l = c.history.redo();
    if (l)
      void c.view.applyLayout(sanitizeLayout(l, ids)).then(() => {
        persist();
        toolbar.refresh();
      });
  },
  grid: () => ctxs.length,
  setGrid,
  layoutName: () => layoutName,
  savedLayouts: () => Object.keys(savedLayouts()).sort(),
  saveLayout: (name) => {
    const all = savedLayouts();
    all[name] = workspace();
    localStorage.setItem(KEYS.layouts, JSON.stringify(all));
    layoutName = name;
    toast(`Layout "${name}" saved`);
    toolbar.refresh();
  },
  loadLayout: (name) => {
    const w = savedLayouts()[name];
    if (!w) return;
    layoutName = name;
    restore(w);
  },
  deleteLayout: (name) => {
    const all = savedLayouts();
    delete all[name];
    localStorage.setItem(KEYS.layouts, JSON.stringify(all));
    if (layoutName === name) layoutName = "";
    toolbar.refresh();
  },
  theme: () => theme,
  toggleTheme: () => {
    theme = theme === "dark" ? "light" : "dark";
    applyTheme();
    toolbar.refresh();
  },
  screenshot: () => {
    const v = active().view;
    v.screenshot().toBlob((b) => b && download(`${v.symbol}-${v.layout.interval}-${new Date().toISOString().slice(0, 10)}.png`, b));
  },
  exportCsv: () => {
    const v = active().view;
    download(`${v.symbol}-${v.layout.interval}.csv`, new Blob([v.csv()], { type: "text/csv" }));
  },
  resetAll: () => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("heatcharting."))
      .forEach((k) => localStorage.removeItem(k));
    location.reload();
  },
  paper: () => account,
  paperOrder: (side, qty) => {
    const v = active().view;
    const r = order(account, v.symbol, side, qty, v.lastPrice, Date.now());
    if (!r.ok) return r.error;
    account = r.account;
    saveAccount(account);
    toast(`Paper ${side}: ${qty} ${v.symbol} at ${r.trade.price.toFixed(2)}`);
    return null;
  },
  paperReset: () => {
    account = newAccount();
    saveAccount(account);
  },
  priceOf: (sym) => ctxs.find((c) => c.view.symbol === sym)?.view.lastPrice ?? null,
};
const toolbar = buildToolbar($("toolbar"), app);

function restore(w: Workspace) {
  ctxs.forEach((c) => c.view.dispose());
  gridEl.innerHTML = "";
  ctxs = [];
  const n = [1, 2, 4].includes(w.grid) ? w.grid : 1;
  const list = (w.views ?? []).slice(0, n);
  for (let i = 0; i < n; i++) {
    const v = list[i];
    ctxs.push(createView(v?.symbol || DEFAULT_SYMBOLS[i], v ? sanitizeLayout(v.layout, ids) : undefined));
  }
  activeIx = Math.min(w.active ?? 0, ctxs.length - 1);
  gridEl.className = `grid g${ctxs.length}`;
  persist();
  showActive();
}

// ------------------------------------------------------------------ drawing tools (left side)
const ICONS: Record<string, string> = {
  cursor: '<path d="M5 3l12 8-5 1.5L9.5 18z" fill="currentColor"/>',
  trend: '<path d="M4 18L18 5" stroke="currentColor" stroke-width="1.8" fill="none"/><circle cx="4" cy="18" r="2" fill="currentColor"/><circle cx="18" cy="5" r="2" fill="currentColor"/>',
  ray: '<path d="M4 17L20 5" stroke="currentColor" stroke-width="1.8" fill="none"/><circle cx="4" cy="17" r="2" fill="currentColor"/><path d="M17 4l4 0 0 4" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  hline: '<path d="M3 12h18" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  vline: '<path d="M12 3v18" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  rect: '<rect x="4" y="6" width="16" height="12" stroke="currentColor" stroke-width="1.8" fill="none" rx="1"/>',
  fib: '<path d="M3 5h18M3 10h18M3 14h18M3 19h18" stroke="currentColor" stroke-width="1.4"/>',
  text: '<path d="M6 6h12M12 6v13" stroke="currentColor" stroke-width="2" fill="none"/>',
  measure: '<path d="M4 17L17 4l3 3L7 20z" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M8 13l2 2M11 10l2 2M14 7l2 2" stroke="currentColor" stroke-width="1.4"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="1.6" fill="none"/>',
};
const svg = (n: string) => `<svg viewBox="0 0 24 24" width="20" height="20">${ICONS[n]}</svg>`;
const toolsEl = $("tools");
function buildTools() {
  const btn = (id: string, title: string, icon: string, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dt";
    b.dataset.id = id;
    b.title = title;
    b.innerHTML = svg(icon);
    b.addEventListener("click", act);
    toolsEl.appendChild(b);
  };
  for (const t of TOOLS) btn(t.id, `${t.label}: ${t.hint}`, t.id, () => {
    active().view.setTool(t.id as Tool);
    refreshTools();
  });
  const hr = document.createElement("div");
  hr.className = "dsep";
  toolsEl.appendChild(hr);
  btn("magnet", "Magnet: snap to the open, high, low and close of a candle", "magnet", () => {
    const v = active().view;
    v.setMagnet(!v.drawState.magnet);
    refreshTools();
  });
  btn("hide", "Show or hide all drawings", "eye", () => {
    const v = active().view;
    v.setDrawingsHidden(!v.drawState.hidden);
    refreshTools();
  });
  btn("delete", "Delete the selected drawing (Delete key). Ctrl+Z undoes a drawing change", "trash", () => {
    const v = active().view;
    if (v.drawState.selected) v.deleteSelectedDrawing();
    else if (v.drawState.count && confirm("Remove all drawings on this chart?")) v.clearDrawings();
    refreshTools();
  });
  const sw = document.createElement("div");
  sw.className = "swatches";
  for (const c of COLORS) {
    const s = document.createElement("button");
    s.type = "button";
    s.className = "sw";
    s.dataset.c = c;
    s.style.background = c;
    s.title = "Drawing colour";
    s.addEventListener("click", () => {
      active().view.setDrawingColor(c);
      refreshTools();
    });
    sw.appendChild(s);
  }
  toolsEl.appendChild(sw);
}
function refreshTools() {
  if (!ctxs.length) return;
  const st = active().view.drawState;
  toolsEl.querySelectorAll<HTMLElement>(".dt").forEach((b) => {
    const id = b.dataset.id!;
    b.classList.toggle("on", id === st.tool || (id === "magnet" && st.magnet) || (id === "hide" && st.hidden));
  });
  toolsEl.querySelectorAll<HTMLElement>(".sw").forEach((b) => b.classList.toggle("on", b.dataset.c === st.color));
}
buildTools();

// ------------------------------------------------------------------ replay bar
function showReplay() {
  const r = active().view.replay;
  $("replayBar").hidden = !r.active;
  if (!r.active) return;
  const s = $("rwSlider") as HTMLInputElement;
  s.max = String(Math.max(1, r.total - 1));
  s.value = String(r.index);
  $("rwPlay").innerHTML = r.playing ? "&#10074;&#10074;" : "&#9654;";
  $("rwTime").textContent = r.time != null ? new Date(r.time * 1000).toISOString().replace("T", " ").slice(0, 16) + " IST" : "-";
}
$("rwBack").addEventListener("click", () => {
  active().view.step(-1);
  showReplay();
});
$("rwFwd").addEventListener("click", () => {
  active().view.step(1);
  showReplay();
});
$("rwPlay").addEventListener("click", () => {
  const v = active().view;
  if (v.replay.playing) v.pause();
  else v.play(Number(($("rwSpeed") as HTMLSelectElement).value));
  showReplay();
});
$("rwSpeed").addEventListener("change", () => {
  const v = active().view;
  if (v.replay.playing) v.play(Number(($("rwSpeed") as HTMLSelectElement).value));
});
$("rwSlider").addEventListener("input", (e) => {
  active().view.seek(Number((e.target as HTMLInputElement).value));
  showReplay();
});
$("rwExit").addEventListener("click", () => active().view.stopReplay());
setInterval(() => {
  if (active() && active().view.replay.playing) showReplay();
}, 250);

// ------------------------------------------------------------------ status line and search
setInterval(() => {
  const c = active();
  if (!c || !c.view.symbol) return;
  const quiet = c.view.lastLive ? (Date.now() - c.view.lastLive) / 1000 : Infinity;
  if (c.view.replay.active) setStatus(c, "Replay", "warn");
  else if (quiet < 15) setStatus(c, "Live", "ok");
  else if (c.view.lastLive) setStatus(c, `No update for ${Math.round(quiet)}s`, "warn");
  else setStatus(c, "Waiting for the feed (market closed? showing the last recorded session)", "warn");
}, 1000);

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
  const c = active();
  c.walls = [];
  c.snap = null;
  showWalls(c);
  history.replaceState(null, "", `#${li.dataset.s}`);
  void c.view.setSymbol(li.dataset.s!).then(persist);
  showQuote(c);
});
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter") (results.querySelector("li") as HTMLElement | null)?.click();
});
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".search")) results.hidden = true;
});

// ------------------------------------------------------------------ start
applyTheme();
void api
  .health()
  .then((h) => {
    if (!h.angel_configured) toast("Angel One credentials are missing: copy .env.example to .env and fill it in");
  })
  .catch(() => toast("The server is not reachable"));

const fromHash = location.hash.slice(1).toUpperCase();
const savedWork = read<Workspace | null>(KEYS.work, null);
if (savedWork && savedWork.views?.length) {
  const ix = Math.min(savedWork.active ?? 0, savedWork.views.length - 1);
  if (fromHash) savedWork.views[ix].symbol = fromHash;
  restore(savedWork);
} else {
  restore({ grid: 1, views: [{ symbol: fromHash || "RELIANCE", layout: cloneLayout(DEFAULT_LAYOUT) }], active: 0 });
}
