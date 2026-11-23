/** Price alerts. They are checked in the browser against the live price, so they only fire while the page is open. */
export interface Alert {
  id: string;
  symbol: string;
  price: number;
  dir: "above" | "below";
  created: number;
  triggered?: number;
}

/** An alert above the price waits for a rise to it; one below waits for a fall. A level equal to the price is treated as above. */
export const directionFor = (level: number, ltp: number | null): "above" | "below" => (ltp != null && level < ltp ? "below" : "above");

/** True when the price has just reached the level. With no previous price we cannot say it crossed, so it does not fire. */
export function crossed(a: Pick<Alert, "price" | "dir">, prev: number | null, now: number | null): boolean {
  if (prev == null || now == null) return false;
  return a.dir === "above" ? prev < a.price && now >= a.price : prev > a.price && now <= a.price;
}

export function evaluate(alerts: Alert[], symbol: string, prev: number | null, now: number | null): Alert[] {
  return alerts.filter((a) => a.symbol === symbol && a.triggered == null && crossed(a, prev, now));
}

const KEY = "heatcharting.alerts";
export function loadAlerts(): Alert[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((a) => a && typeof a.price === "number" && typeof a.symbol === "string" && (a.dir === "above" || a.dir === "below")) : [];
  } catch {
    return [];
  }
}
export const saveAlerts = (a: Alert[]) => localStorage.setItem(KEY, JSON.stringify(a));
