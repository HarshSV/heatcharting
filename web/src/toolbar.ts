import * as api from "./api";
import type { Alert } from "./alerts";
import type { Account } from "./paper";
import { realisedTotal, unrealised } from "./paper";
import { DEFAULTS, type HeatOptions } from "./scale";
import { CHART_TYPES, INDICATOR_DEFS, describe, type IndicatorKind, type IndicatorSpec } from "./state";
import { INTERVALS } from "./transform";
import type { ChartView } from "./view";

/** Everything the toolbar needs from the app. The toolbar draws; main.ts decides. */
export interface App {
  active(): ChartView;
  views(): ChartView[];
  heatOpts(): HeatOptions;
  setHeatOpts(o: HeatOptions): void;
  alerts(): Alert[];
  addAlert(price: number): void;
  removeAlert(id: string): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  grid(): number;
  setGrid(n: number): void;
  layoutName(): string;
  savedLayouts(): string[];
  saveLayout(name: string): void;
  loadLayout(name: string): void;
  deleteLayout(name: string): void;
  theme(): "dark" | "light";
  toggleTheme(): void;
  screenshot(): void;
  exportCsv(): void;
  resetAll(): void;
  paper(): Account;
  paperOrder(side: "buy" | "sell", qty: number): string | null;
  paperReset(): void;
  priceOf(symbol: string): number | null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const inr = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

class Popover {
  readonly btn: HTMLButtonElement;
  readonly panel: HTMLElement;
  constructor(parent: HTMLElement, label: string, title: string, private build: (p: HTMLElement) => void, private align: "left" | "right" = "left", cls = "") {
    const wrap = document.createElement("div");
    wrap.className = `pop ${cls}`;
    wrap.innerHTML = `<button type="button" class="tb" title="${esc(title)}">${label}</button><div class="panel" hidden></div>`;
    parent.appendChild(wrap);
    this.btn = wrap.querySelector("button") as HTMLButtonElement;
    this.panel = wrap.querySelector(".panel") as HTMLElement;
    this.btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = !this.panel.hidden;
      document.dispatchEvent(new CustomEvent("closepops"));
      if (!wasOpen) this.open();
    });
    this.panel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("closepops", () => this.close());
    document.addEventListener("click", () => this.close());
  }
  open() {
    this.refresh();
    this.panel.hidden = false;
    this.btn.classList.add("on");
    // the toolbar scrolls sideways, so panels are placed against the window from the button's position
    const r = this.btn.getBoundingClientRect();
    const w = this.panel.offsetWidth;
    this.panel.style.top = `${r.bottom}px`;
    this.panel.style.left = `${Math.max(8, this.align === "right" ? r.right - w : Math.min(r.left, window.innerWidth - w - 8))}px`;
  }
  close() {
    this.panel.hidden = true;
    this.btn.classList.remove("on");
  }
  get isOpen() {
    return !this.panel.hidden;
  }
  refresh() {
    this.build(this.panel);
  }
}

export interface Toolbar {
  refresh(): void;
  closeAll(): void;
}

export function buildToolbar(root: HTMLElement, app: App): Toolbar {
  root.innerHTML = "";
  const group = () => {
    const g = document.createElement("div");
    g.className = "tg";
    root.appendChild(g);
    return g;
  };
  const sep = () => {
    const s = document.createElement("span");
    s.className = "sep";
    root.appendChild(s);
  };
  const pops: Popover[] = [];
  const pop = (...a: ConstructorParameters<typeof Popover>) => {
    const p = new Popover(...a);
    pops.push(p);
    return p;
  };

  // ---- compare
  const g1 = group();
  const compare = pop(g1, "&#43; Compare", "Compare with another symbol", (p) => {
    const v = app.active();
    p.innerHTML = `<h4>Compare</h4><p class="hint">Draws another symbol on this chart, rebased to start at the same price.</p>
      <input class="in" id="cmpq" placeholder="Search a symbol" autocomplete="off" spellcheck="false" /><ul class="list" id="cmpres"></ul>
      <h5>On this chart</h5>${v.layout.compares.length ? v.layout.compares.map((s) => `<div class="li"><span>${esc(s)}</span><button class="x" data-rm="${esc(s)}">Remove</button></div>`).join("") : '<p class="hint">None.</p>'}`;
    const q = p.querySelector("#cmpq") as HTMLInputElement;
    const res = p.querySelector("#cmpres") as HTMLElement;
    let t = 0;
    q.addEventListener("input", () => {
      clearTimeout(t);
      t = window.setTimeout(async () => {
        const f = q.value.trim() ? await api.search(q.value.trim()).catch(() => []) : [];
        res.innerHTML = f.map((c) => `<li data-add="${esc(c.symbol)}"><b>${esc(c.symbol)}</b> <span>${esc(c.name)}</span></li>`).join("");
      }, 200);
    });
    res.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest("li");
      const s = li?.dataset.add;
      if (!s || v.layout.compares.includes(s) || s === v.symbol || v.layout.compares.length >= 4) return;
      v.setCompares([...v.layout.compares, s]);
      compare.refresh();
    });
    p.querySelectorAll<HTMLElement>("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => {
        v.setCompares(v.layout.compares.filter((s) => s !== b.dataset.rm));
        compare.refresh();
      }),
    );
  });

  sep();
  // ---- timeframes
  const g2 = group();
  const quick = ["1m", "5m", "15m", "1h", "4h", "D"];
  const ivBtns = quick.map((id) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tb iv";
    b.dataset.iv = id;
    b.textContent = id;
    b.addEventListener("click", () => void app.active().setInterval(id));
    g2.appendChild(b);
    return b;
  });
  const more = pop(g2, "&#9662;", "More timeframes", (p) => {
    const cur = app.active().layout.interval;
    p.innerHTML = INTERVALS.filter((i) => !quick.includes(i.id)).map((i) => `<button class="mi ${cur === i.id ? "sel" : ""}" data-iv="${i.id}">${i.label === "W" ? "Weekly" : i.label === "3m" ? "3 minutes" : "30 minutes"}</button>`).join("");
    p.querySelectorAll<HTMLElement>("[data-iv]").forEach((b) => b.addEventListener("click", () => { void app.active().setInterval(b.dataset.iv!); more.close(); }));
  });

  sep();
  // ---- chart type
  const g3 = group();
  const type = pop(g3, "Candles", "Chart type", (p) => {
    const cur = app.active().layout.type;
    p.innerHTML = CHART_TYPES.map((t) => `<button class="mi ${cur === t.id ? "sel" : ""}" data-t="${t.id}">${t.label}</button>`).join("");
    p.querySelectorAll<HTMLElement>("[data-t]").forEach((b) => b.addEventListener("click", () => { app.active().setType(b.dataset.t as never); type.close(); }));
  });

  // ---- indicators
  const ind = pop(g3, "Indicators", "Indicators", (p) => {
    const v = app.active();
    const kinds = Object.entries(INDICATOR_DEFS) as [IndicatorKind, { label: string }][];
    p.innerHTML = `<h4>Add indicator</h4><div class="grid2">${kinds.map(([k, d]) => `<button class="mi" data-add="${k}">${d.label}</button>`).join("")}</div>
      <h5>On this chart</h5>${v.layout.indicators.length ? v.layout.indicators.map((s) => rowFor(s)).join("") : '<p class="hint">None.</p>'}`;
    p.querySelectorAll<HTMLElement>("[data-add]").forEach((b) => b.addEventListener("click", () => { app.active().addIndicator(b.dataset.add as IndicatorKind); ind.refresh(); }));
    p.querySelectorAll<HTMLElement>("[data-del]").forEach((b) => b.addEventListener("click", () => { app.active().removeIndicator(b.dataset.del!); ind.refresh(); }));
    p.querySelectorAll<HTMLInputElement>("input[data-p]").forEach((i) => i.addEventListener("change", () => { app.active().updateIndicator(i.dataset.id!, { [i.dataset.p!]: Number(i.value) } as Partial<IndicatorSpec>); ind.refresh(); }));
    p.querySelectorAll<HTMLInputElement>("input[data-c]").forEach((i) => i.addEventListener("change", () => { app.active().updateIndicator(i.dataset.id!, { color: i.value }); ind.refresh(); }));
  });
  const rowFor = (s: IndicatorSpec) => {
    const d = INDICATOR_DEFS[s.kind].defaults;
    const f = (k: "period" | "period2" | "period3", title: string) => (d[k] != null ? `<label class="pi" title="${title}"><input type="number" min="1" max="500" value="${s[k] ?? d[k]}" data-p="${k}" data-id="${esc(s.id)}" /></label>` : "");
    return `<div class="li"><span class="dot" style="background:${s.color}"></span><span class="grow">${esc(describe(s))}</span>${f("period", "Period")}${f("period2", s.kind === "bb" ? "Std deviations" : "Slow period")}${f("period3", "Signal period")}<input class="col" type="color" value="${s.color}" data-c="1" data-id="${esc(s.id)}" /><button class="x" data-del="${esc(s.id)}">Remove</button></div>`;
  };

  // ---- visibility (the eye)
  pop(g3, "&#128065;", "Show or hide chart layers", (p) => {
    const h = app.active().layout.hide;
    const row = (k: string, label: string, hidden: boolean) => `<label class="ck"><input type="checkbox" data-h="${k}" ${hidden ? "" : "checked"} /> ${label}</label>`;
    p.innerHTML = `<h4>Visible layers</h4>${row("heat", "Liquidity heat", h.heat)}${row("walls", "Wall markers", h.walls)}${row("indicators", "Indicators", h.indicators)}${row("compares", "Compared symbols", h.compares)}`;
    p.querySelectorAll<HTMLInputElement>("input[data-h]").forEach((i) => i.addEventListener("change", () => app.active().setHide({ [i.dataset.h!]: !i.checked } as never)));
  });

  // ---- trade flow
  const flow = pop(g3, "Flow", "Trade flow: footprint, volume profile, delta", (p) => {
    const v = app.active();
    const f = v.layout.flow;
    p.innerHTML = `<h4>Trade flow</h4>
      <p class="hint">Estimated from the live depth feed (about one reading a second): the volume added between readings is placed at the last price and called a buy or a sell from the best bid and ask. Several trades in one second are lumped together, so read it as a guide, not a tape. ${v.flowCount ? `${v.flowCount.toLocaleString("en-IN")} readings so far.` : "None recorded yet for this session."}</p>
      <label class="ck"><input type="checkbox" id="ffp" ${f.footprint ? "checked" : ""} /> Footprint <small>(sell &times; buy at each price, zoom in)</small></label>
      <label class="ck"><input type="checkbox" id="fpr" ${f.profile ? "checked" : ""} /> Volume profile <small>(volume at price in view)</small></label>
      <h5>Panes</h5>
      <div class="grid2"><button class="mi" id="fdl">+ Delta</button><button class="mi" id="fcv">+ Cumulative delta</button></div>`;
    p.querySelector("#ffp")!.addEventListener("change", (e) => { v.setFlow({ footprint: (e.target as HTMLInputElement).checked }); flow.refresh(); });
    p.querySelector("#fpr")!.addEventListener("change", (e) => { v.setFlow({ profile: (e.target as HTMLInputElement).checked }); flow.refresh(); });
    const add = (kind: "delta" | "cvd") => { if (!v.layout.indicators.some((i) => i.kind === kind)) v.addIndicator(kind); flow.close(); };
    p.querySelector("#fdl")!.addEventListener("click", () => add("delta"));
    p.querySelector("#fcv")!.addEventListener("click", () => add("cvd"));
  });

  // ---- heat controls
  const heat = pop(g3, "Heat", "Heat colour controls", (p) => {
    const o = app.heatOpts();
    const slider = (o.minQty <= 0 ? 0 : Math.round(20 * Math.log10(o.minQty)));
    p.innerHTML = `<h4>Heat</h4>
      <div class="field"><span>Scale</span><div class="seg"><button data-sc="log" class="${o.scale === "log" ? "on" : ""}">Log</button><button data-sc="linear" class="${o.scale === "linear" ? "on" : ""}">Linear</button></div></div>
      <label class="field"><span>Opacity <b>${Math.round(o.opacity * 100)}%</b></span><input type="range" id="hop" min="10" max="100" step="5" value="${Math.round(o.opacity * 100)}" /></label>
      <label class="field"><span>Min size <b>${o.minQty > 0 ? o.minQty.toLocaleString("en-IN") : "all"}</b></span><input type="range" id="hmin" min="0" max="100" step="1" value="${slider}" /></label>
      <label class="ck"><input type="checkbox" id="hw" ${o.wallsOnly ? "checked" : ""} /> Walls only <small>(largest tenth in view)</small></label>
      <label class="ck"><input type="checkbox" id="hm" ${o.showWalls ? "checked" : ""} /> Wall markers <small>(appeared, pulled, eaten)</small></label>
      <button class="link" id="hreset">Reset</button>`;
    const set = (n: Partial<HeatOptions>) => { app.setHeatOpts({ ...app.heatOpts(), ...n }); heat.refresh(); };
    p.querySelectorAll<HTMLElement>("[data-sc]").forEach((b) => b.addEventListener("click", () => set({ scale: b.dataset.sc as never })));
    p.querySelector("#hop")!.addEventListener("change", (e) => set({ opacity: Number((e.target as HTMLInputElement).value) / 100 }));
    p.querySelector("#hmin")!.addEventListener("change", (e) => { const v = Number((e.target as HTMLInputElement).value); set({ minQty: v <= 0 ? 0 : Math.round(10 ** (v / 20)) }); });
    p.querySelector("#hw")!.addEventListener("change", (e) => set({ wallsOnly: (e.target as HTMLInputElement).checked }));
    p.querySelector("#hm")!.addEventListener("change", (e) => set({ showWalls: (e.target as HTMLInputElement).checked }));
    p.querySelector("#hreset")!.addEventListener("click", () => set(DEFAULTS));
  });

  sep();
  // ---- alerts
  const g4 = group();
  const alert = pop(g4, "&#128276;", "Price alerts", (p) => {
    const v = app.active();
    const mine = app.alerts().filter((a) => a.symbol === v.symbol);
    const px = v.lastPrice != null ? v.lastPrice.toFixed(2) : "";
    p.innerHTML = `<h4>Alerts for ${esc(v.symbol || "-")}</h4>
      <div class="row2"><input class="in" id="alp" type="number" step="0.05" placeholder="Price" value="${px}" /><button class="btn" id="aladd">Add</button></div>
      <p class="hint">Fires when the price reaches the level, in this page while it is open. ${"Notification" in window && Notification.permission === "denied" ? "Browser notifications are blocked, so you will see an on-screen message only." : ""}</p>
      ${mine.length ? mine.map((a) => `<div class="li"><span class="grow">${a.dir === "above" ? "&#9650;" : "&#9660;"} ${inr(a.price)} ${a.triggered ? '<em class="done">triggered</em>' : ""}</span><button class="x" data-rm="${esc(a.id)}">Remove</button></div>`).join("") : '<p class="hint">None yet.</p>'}`;
    p.querySelector("#aladd")!.addEventListener("click", () => {
      const n = Number((p.querySelector("#alp") as HTMLInputElement).value);
      if (Number.isFinite(n) && n > 0) { app.addAlert(n); alert.refresh(); }
    });
    p.querySelectorAll<HTMLElement>("[data-rm]").forEach((b) => b.addEventListener("click", () => { app.removeAlert(b.dataset.rm!); alert.refresh(); }));
  });

  // ---- replay
  const replayBtn = document.createElement("button");
  replayBtn.type = "button";
  replayBtn.className = "tb";
  replayBtn.title = "Replay: step through the past, with the heat as it was";
  replayBtn.innerHTML = "&#9198; Replay";
  replayBtn.addEventListener("click", () => {
    const v = app.active();
    if (v.replay.active) v.stopReplay();
    else v.startReplay();
  });
  g4.appendChild(replayBtn);

  sep();
  // ---- undo / redo
  const g5 = group();
  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "tb";
  undoBtn.title = "Undo";
  undoBtn.innerHTML = "&#8630;";
  undoBtn.addEventListener("click", () => app.undo());
  const redoBtn = document.createElement("button");
  redoBtn.type = "button";
  redoBtn.className = "tb";
  redoBtn.title = "Redo";
  redoBtn.innerHTML = "&#8631;";
  redoBtn.addEventListener("click", () => app.redo());
  g5.append(undoBtn, redoBtn);

  sep();
  // ---- layout grid + saved layouts
  const g6 = group();
  const grid = pop(g6, "&#9638; 1", "Number of charts", (p) => {
    const n = app.grid();
    p.innerHTML = [1, 2, 4].map((k) => `<button class="mi ${n === k ? "sel" : ""}" data-g="${k}">${k === 1 ? "1 chart" : k === 2 ? "2 charts side by side" : "4 charts (2 x 2)"}</button>`).join("");
    p.querySelectorAll<HTMLElement>("[data-g]").forEach((b) => b.addEventListener("click", () => { app.setGrid(Number(b.dataset.g)); grid.close(); }));
  });
  const saved = pop(g6, "Unnamed", "Save and load layouts", (p) => {
    const names = app.savedLayouts();
    p.innerHTML = `<h4>Layouts</h4><div class="row2"><input class="in" id="lname" placeholder="Name this layout" value="${esc(app.layoutName())}" /><button class="btn" id="lsave">Save</button></div>
      ${names.length ? names.map((n) => `<div class="li"><button class="mi grow" data-load="${esc(n)}">${esc(n)}</button><button class="x" data-del="${esc(n)}">Delete</button></div>`).join("") : '<p class="hint">No saved layouts. A layout keeps the symbols, timeframes, chart types, indicators and visibility of every chart.</p>'}`;
    p.querySelector("#lsave")!.addEventListener("click", () => { const n = (p.querySelector("#lname") as HTMLInputElement).value.trim(); if (n) { app.saveLayout(n); saved.refresh(); } });
    p.querySelectorAll<HTMLElement>("[data-load]").forEach((b) => b.addEventListener("click", () => { app.loadLayout(b.dataset.load!); saved.close(); }));
    p.querySelectorAll<HTMLElement>("[data-del]").forEach((b) => b.addEventListener("click", () => { app.deleteLayout(b.dataset.del!); saved.refresh(); }));
  });

  // ---- right side: theme, screenshot, more, trade
  const right = document.createElement("div");
  right.className = "tg right";
  root.appendChild(right);
  const themeBtn = document.createElement("button");
  themeBtn.type = "button";
  themeBtn.className = "tb";
  themeBtn.addEventListener("click", () => app.toggleTheme());
  const shotBtn = document.createElement("button");
  shotBtn.type = "button";
  shotBtn.className = "tb";
  shotBtn.title = "Save a picture of the chart";
  shotBtn.innerHTML = "&#128247;";
  shotBtn.addEventListener("click", () => app.screenshot());
  const zbtn = (label: string, title: string, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tb";
    b.title = title;
    b.innerHTML = label;
    b.addEventListener("click", act);
    return b;
  };
  right.append(
    zbtn("&minus;", "Zoom out", () => app.active().zoom(1.5)),
    zbtn("&#43;", "Zoom in", () => app.active().zoom(1 / 1.5)),
    zbtn("&#9197;", "Jump to the latest bar", () => app.active().latest()),
    themeBtn,
    shotBtn,
  );
  const moreMenu = pop(right, "&#8943;", "More", (p) => {
    p.innerHTML = `<button class="mi" id="csv">Export candles (CSV)</button><button class="mi" id="rst">Reset everything saved here</button>`;
    p.querySelector("#csv")!.addEventListener("click", () => { app.exportCsv(); moreMenu.close(); });
    p.querySelector("#rst")!.addEventListener("click", () => { if (confirm("Clear saved layouts, alerts, paper trades and settings in this browser?")) app.resetAll(); });
  }, "right");

  // ---- paper trade
  const trade = pop(right, "Trade", "Paper trading (practice only)", (p) => {
    const v = app.active();
    const acc = app.paper();
    const prices: Record<string, number | null> = {};
    for (const pos of Object.values(acc.positions)) prices[pos.symbol] = app.priceOf(pos.symbol);
    const u = unrealised(acc, prices);
    const px = v.lastPrice;
    p.innerHTML = `<h4>Paper trading <small>practice only, no real orders</small></h4>
      <div class="kv"><span>${esc(v.symbol || "-")}</span><b>${px != null ? inr(px) : "no price yet"}</b></div>
      <div class="row2"><input class="in" id="tq" type="number" min="1" step="1" value="1" /><button class="btn buy" id="tb">Buy</button><button class="btn sell" id="ts">Sell</button></div>
      <p class="msg" id="tmsg"></p>
      <div class="kv"><span>Cash</span><b>${inr(acc.cash)}</b></div>
      <div class="kv"><span>Realised</span><b class="${realisedTotal(acc) >= 0 ? "up" : "down"}">${inr(realisedTotal(acc))}</b></div>
      <div class="kv"><span>Open P&amp;L</span><b class="${u.pnl >= 0 ? "up" : "down"}">${inr(u.pnl)}${u.unknown.length ? ` <small>(no price for ${esc(u.unknown.join(", "))})</small>` : ""}</b></div>
      <h5>Positions</h5>${Object.values(acc.positions).length ? Object.values(acc.positions).map((pos) => `<div class="li"><span class="grow">${esc(pos.symbol)} ${pos.qty > 0 ? "long" : "short"} ${Math.abs(pos.qty)} @ ${inr(pos.avg)}</span></div>`).join("") : '<p class="hint">None.</p>'}
      <h5>Last trades</h5>${acc.trades.slice(-6).reverse().map((t) => `<div class="li"><span class="grow">${t.side} ${t.qty} ${esc(t.symbol)} @ ${inr(t.price)}</span>${t.realised ? `<b class="${t.realised >= 0 ? "up" : "down"}">${inr(t.realised)}</b>` : ""}</div>`).join("") || '<p class="hint">None.</p>'}
      <button class="link" id="tr">Reset account</button>`;
    const go = (side: "buy" | "sell") => {
      const err = app.paperOrder(side, Number((p.querySelector("#tq") as HTMLInputElement).value));
      trade.refresh();
      if (err) (trade.panel.querySelector("#tmsg") as HTMLElement).textContent = err;
    };
    p.querySelector("#tb")!.addEventListener("click", () => go("buy"));
    p.querySelector("#ts")!.addEventListener("click", () => go("sell"));
    p.querySelector("#tr")!.addEventListener("click", () => { if (confirm("Reset the paper account to its starting cash?")) { app.paperReset(); trade.refresh(); } });
  }, "right", "trade");

  const refresh = () => {
    const v = app.active();
    ivBtns.forEach((b) => b.classList.toggle("sel", b.dataset.iv === v.layout.interval));
    more.btn.classList.toggle("sel", !quick.includes(v.layout.interval));
    type.btn.textContent = CHART_TYPES.find((t) => t.id === v.layout.type)?.label ?? "Candles";
    undoBtn.disabled = !app.canUndo();
    redoBtn.disabled = !app.canRedo();
    replayBtn.classList.toggle("on", v.replay.active);
    grid.btn.innerHTML = `&#9638; ${app.grid()}`;
    saved.btn.textContent = app.layoutName() || "Unnamed";
    themeBtn.innerHTML = app.theme() === "dark" ? "&#9728;" : "&#9790;";
    themeBtn.title = app.theme() === "dark" ? "Light theme" : "Dark theme";
    for (const p of pops) if (p.isOpen && p !== alert) p.refresh();
  };
  return { refresh, closeAll: () => pops.forEach((p) => p.close()) };
}
