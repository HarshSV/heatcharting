"""Trade flow: how much traded at which price, and whether buyers or sellers were the aggressors, estimated from the depth snapshots.

Angel One sends a snapshot about once a second with the day's cumulative volume. The volume added between two snapshots traded at about the last
price, so each pair of snapshots gives one flow event {t, price, qty, side}. This is an ESTIMATE, not a tape of every trade:
  * several trades inside one second are lumped into one event at the last price;
  * side uses the quote rule first (a last price at or above the previous best ask is a buy, at or below the previous best bid is a sell), then
    the tick rule (price up is a buy, down is a sell), then the previous side; if none applies the side is 0 (unclassified).
Unknown stays unknown: a snapshot without volume or price produces no event, and a falling day volume (a reset) is ignored, never turned into zero."""
from __future__ import annotations


def classify(prev: dict | None, snap: dict, last_side: int = 0) -> dict | None:
    """The flow event between two consecutive snapshots, or None when there is nothing trustworthy to report."""
    if not prev:
        return None
    v0, v1 = prev.get("vol"), snap.get("vol")
    if not isinstance(v0, (int, float)) or not isinstance(v1, (int, float)) or v1 <= v0:
        return None
    price, t = snap.get("ltp"), snap.get("t")
    if price is None or t is None:
        return None
    ask = prev["asks"][0][0] if prev.get("asks") else None
    bid = prev["bids"][0][0] if prev.get("bids") else None
    if ask is not None and price >= ask:
        side = 1
    elif bid is not None and price <= bid:
        side = -1
    elif prev.get("ltp") is not None and price > prev["ltp"]:
        side = 1
    elif prev.get("ltp") is not None and price < prev["ltp"]:
        side = -1
    else:
        side = last_side
    return {"t": t, "price": price, "qty": int(v1 - v0), "side": side}


class FlowTracker:
    """One per symbol: feed it every snapshot in time order with `update`."""

    def __init__(self) -> None:
        self.prev: dict | None = None
        self.side = 0

    def update(self, snap: dict) -> dict | None:
        ev = classify(self.prev, snap, self.side)
        if snap.get("vol") is not None:
            self.prev = snap
        if ev and ev["side"] != 0:
            self.side = ev["side"]
        return ev
