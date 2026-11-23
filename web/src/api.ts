export type Level = [price: number, qty: number, orders: number | null];

export interface Snapshot {
  t: number; // milliseconds since the epoch
  ltp: number | null;
  vol?: number | null;
  bids: Level[];
  asks: Level[];
}

export interface WallEvent {
  t: number;
  kind: "appeared" | "pulled" | "eaten";
  side: "bid" | "ask";
  price: number;
  qty: number | null;
  held_s?: number | null;
}

export interface Candle {
  time: number; // UTC seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Company {
  symbol: string;
  name: string;
  token: string;
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    let detail = r.statusText;
    try {
      detail = (await r.json()).detail ?? detail;
    } catch {
      /* keep the status text */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

export const search = (q: string) => get<Company[]>(`/api/search?q=${encodeURIComponent(q)}`);
export const candles = (symbol: string, days = 2) =>
  get<{ candles: Candle[] }>(`/api/candles?symbol=${encodeURIComponent(symbol)}&days=${days}`).then((r) => r.candles);
export const snapshots = (symbol: string, minutes = 90) =>
  get<{ snapshots: Snapshot[]; note?: string }>(`/api/snapshots?symbol=${encodeURIComponent(symbol)}&minutes=${minutes}`);
export const walls = (symbol: string, minutes = 90) =>
  get<{ events: WallEvent[] }>(`/api/walls?symbol=${encodeURIComponent(symbol)}&minutes=${minutes}`).then((r) => r.events);
export const health = () => get<{ angel_configured: boolean; feed_connected: boolean; last_message_age_s: number | null }>("/api/health");

/** Live messages for one symbol: depth snapshots and wall events. Reconnects by itself until close() is called. */
export function live(symbol: string, on: { snap: (s: Snapshot) => void; wall: (w: WallEvent) => void }, onState: (open: boolean) => void) {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 1000;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?symbol=${encodeURIComponent(symbol)}`);
    ws.onopen = () => {
      delay = 1000;
      onState(true);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as { type?: string };
      if (m.type === "wall") on.wall(m as unknown as WallEvent);
      else on.snap(m as unknown as Snapshot);
    };
    ws.onclose = () => {
      onState(false);
      if (!stopped) setTimeout(open, (delay = Math.min(delay * 2, 15000)));
    };
  };
  open();
  return { close: () => ((stopped = true), ws?.close()) };
}
