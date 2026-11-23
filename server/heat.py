"""Pure functions for the liquidity heatmap: turn an Angel One snap-quote message into a snapshot, and merge price levels into tick buckets.

A snapshot is {"t": ms since epoch, "ltp": rupees, "bids": [[price, qty, orders], ...], "asks": [...]} with prices in rupees.
Angel sends prices in paise and only the best five levels on each side. A missing value stays None; it is never turned into zero."""
from __future__ import annotations

from collections import defaultdict

DEPTH_LEVELS = 5


def _rupees(paise) -> float | None:
    return round(paise / 100.0, 2) if isinstance(paise, (int, float)) and paise > 0 else None


def _levels(rows) -> list[list]:
    out = []
    for r in rows or []:
        p, q = _rupees(r.get("price")), r.get("quantity")
        if p is None or not isinstance(q, (int, float)) or q < 0:
            continue
        out.append([p, int(q), r.get("no of orders") if isinstance(r.get("no of orders"), int) else None])
    return out


def to_snapshot(msg: dict) -> dict | None:
    """Angel SmartWebSocketV2 snap-quote message -> snapshot, or None when it carries no usable order book."""
    if not isinstance(msg, dict):
        return None
    bids = sorted(_levels(msg.get("best_5_buy_data")), key=lambda x: -x[0])
    asks = sorted(_levels(msg.get("best_5_sell_data")), key=lambda x: x[0])
    if not bids and not asks:
        return None
    ts = msg.get("exchange_timestamp")
    return {"t": int(ts) if isinstance(ts, (int, float)) and ts > 0 else None, "ltp": _rupees(msg.get("last_traded_price")),
            "bids": bids, "asks": asks, "vol": msg.get("volume_trade_for_the_day")}


def tick_size(prices: list[float]) -> float:
    """The smallest gap between distinct prices seen (0.05 for most NSE stocks), 0.05 when there is not enough to tell."""
    ps = sorted({round(p, 2) for p in prices if p})
    gaps = [round(b - a, 2) for a, b in zip(ps, ps[1:]) if b - a > 0]
    return min(gaps) if gaps else 0.05


def rebucket(levels: list[list], step: float) -> list[list]:
    """Merge levels that fall in the same price bucket of `step` rupees (quantities add up, order counts add where known)."""
    if step <= 0:
        raise ValueError("step must be positive")
    acc: dict[float, list] = defaultdict(lambda: [0, None])
    for p, q, n in levels:
        k = round(round(p / step) * step, 4)
        acc[k][0] += q
        if n is not None:
            acc[k][1] = (acc[k][1] or 0) + n
    return [[k, v[0], v[1]] for k, v in sorted(acc.items())]


def max_quantity(snapshots: list[dict]) -> int:
    """The largest resting quantity in a set of snapshots, used to scale the colour of the heat (0 when there are none)."""
    return max((q for s in snapshots for side in ("bids", "asks") for _, q, _ in s.get(side, [])), default=0)
