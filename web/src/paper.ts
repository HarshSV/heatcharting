/** Paper trading: practice orders against live prices. No real order is ever sent anywhere. */
export interface Position {
  symbol: string;
  qty: number; // positive long, negative short
  avg: number;
}

export interface Trade {
  id: number;
  t: number;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  realised: number; // profit or loss booked by this trade (0 when it only opened or added)
}

export interface Account {
  cash: number;
  start: number;
  positions: Record<string, Position>;
  trades: Trade[];
}

export const START_CASH = 1_000_000;

export const newAccount = (cash = START_CASH): Account => ({ cash, start: cash, positions: {}, trades: [] });

export type OrderResult = { ok: true; account: Account; trade: Trade } | { ok: false; error: string };

/** Fill a market order at `price`. Buys cannot take cash below zero. Selling more than you hold opens a short. */
export function order(acc: Account, symbol: string, side: "buy" | "sell", qty: number, price: number | null, t: number): OrderResult {
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: "Quantity must be a whole number above zero." };
  if (price == null || !(price > 0)) return { ok: false, error: "No live price yet." };
  const cost = qty * price;
  if (side === "buy" && acc.cash < cost && !(acc.positions[symbol]?.qty < 0)) return { ok: false, error: "Not enough cash." };
  const signed = side === "buy" ? qty : -qty;
  const pos = acc.positions[symbol] ?? { symbol, qty: 0, avg: 0 };
  let realised = 0;
  let next: Position | null;
  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) {
    const total = pos.qty + signed;
    next = { symbol, qty: total, avg: (Math.abs(pos.qty) * pos.avg + qty * price) / Math.abs(total) };
  } else {
    const closing = Math.min(Math.abs(pos.qty), qty);
    realised = closing * (price - pos.avg) * Math.sign(pos.qty);
    const left = pos.qty + signed;
    next = left === 0 ? null : { symbol, qty: left, avg: Math.sign(left) === Math.sign(pos.qty) ? pos.avg : price };
  }
  const positions = { ...acc.positions };
  if (next) positions[symbol] = next;
  else delete positions[symbol];
  const trade: Trade = { id: acc.trades.length + 1, t, symbol, side, qty, price, realised };
  return { ok: true, trade, account: { ...acc, cash: acc.cash + (side === "buy" ? -cost : cost), positions, trades: [...acc.trades, trade] } };
}

/** Open profit or loss at the given prices. A position with no known price is left out of the sum and listed in `unknown`. */
export function unrealised(acc: Account, prices: Record<string, number | null>): { pnl: number; unknown: string[] } {
  let pnl = 0;
  const unknown: string[] = [];
  for (const p of Object.values(acc.positions)) {
    const px = prices[p.symbol];
    if (px == null) unknown.push(p.symbol);
    else pnl += p.qty * (px - p.avg);
  }
  return { pnl, unknown };
}

export const realisedTotal = (acc: Account) => acc.trades.reduce((s, t) => s + t.realised, 0);

const KEY = "heatcharting.paper";
export function loadAccount(): Account {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (a && typeof a.cash === "number" && a.positions && Array.isArray(a.trades)) return a as Account;
  } catch {
    /* fall through */
  }
  return newAccount();
}
export const saveAccount = (a: Account) => localStorage.setItem(KEY, JSON.stringify(a));
