"""Wall tracking: notice when a large resting order appears, is pulled, or is eaten, from the changes between depth snapshots.

A *wall* is a price level whose resting quantity is unusually large for that stock right now: at least WALL_FACTOR times the median level
quantity seen over the last HISTORY snapshots. Until there are MIN_SAMPLES levels to compare with, no wall is declared (unknown, not "none").

What is observed and what is inferred:
  * appeared  a wall has been standing for CONFIRM_SNAPSHOTS snapshots in a row (so a one-snapshot flicker is not reported).
  * eaten     the wall lost at least DROP_FRACTION of its size AND trading explains it: the price reached the wall, or the volume traded since
              the previous snapshot covers at least half of the lost size.
  * pulled    the wall lost that much but trading does not explain it: the order was cancelled or moved. This is an inference from five visible
              levels, not an observation of the order itself.
A wall whose price falls out of the five visible levels (the price moved away) is dropped silently: we cannot see it, so we do not call it pulled."""
from __future__ import annotations

from collections import deque
from statistics import median

HISTORY = 600            # level quantities remembered per symbol
MIN_SAMPLES = 60
WALL_FACTOR = 3.0
CONFIRM_SNAPSHOTS = 3
DROP_FRACTION = 0.6      # a wall is resolved when it falls to 40% of its peak or less
VOLUME_EXPLAINS = 0.5


def wall_threshold(history) -> float | None:
    """Smallest quantity that counts as a wall, or None while there is too little to judge by."""
    qs = [q for q in history if q > 0]
    return WALL_FACTOR * median(qs) if len(qs) >= MIN_SAMPLES else None


class WallTracker:
    """One per symbol. Feed it every snapshot in time order with `update`; it returns the events that snapshot caused."""

    def __init__(self) -> None:
        self.history: deque = deque(maxlen=HISTORY)
        self.walls: dict[tuple[str, float], dict] = {}     # (side, price) -> {first, peak, seen, announced}
        self.prev_vol: float | None = None

    def update(self, snap: dict) -> list[dict]:
        t = snap["t"]
        ltp = snap.get("ltp")
        vol = snap.get("vol")
        dvol = (vol - self.prev_vol) if isinstance(vol, (int, float)) and isinstance(self.prev_vol, (int, float)) and vol >= self.prev_vol else None
        if isinstance(vol, (int, float)):
            self.prev_vol = vol
        sides = {"bid": snap.get("bids") or [], "ask": snap.get("asks") or []}
        for levels in sides.values():
            for _, q, _ in levels:
                self.history.append(q)
        thr = wall_threshold(self.history)
        events: list[dict] = []
        if thr is None:
            return events

        # the visible price range per side: a level beyond it is out of sight, not gone
        lo_bid = min((p for p, _, _ in sides["bid"]), default=None)
        hi_ask = max((p for p, _, _ in sides["ask"]), default=None)
        now = {(side, p): q for side, lv in sides.items() for p, q, _ in lv}

        for key, q in now.items():                          # new and growing walls
            if q >= thr:
                w = self.walls.setdefault(key, {"first": t, "peak": q, "seen": 0, "announced": False})
                w["peak"] = max(w["peak"], q)
                w["seen"] += 1
                if not w["announced"] and w["seen"] >= CONFIRM_SNAPSHOTS:
                    w["announced"] = True
                    events.append({"t": t, "kind": "appeared", "side": key[0], "price": key[1], "qty": q})

        for key in list(self.walls):                        # standing walls: has one been resolved?
            side, price = key
            w = self.walls[key]
            q = now.get(key)
            if q is None:
                in_view = (side == "bid" and lo_bid is not None and price >= lo_bid) or (side == "ask" and hi_ask is not None and price <= hi_ask)
                if not in_view:
                    del self.walls[key]                     # out of sight: unknown, say nothing
                    continue
                q = 0
            if q >= w["peak"] * (1 - DROP_FRACTION):
                continue                                    # still mostly there
            lost = w["peak"] - q
            reached = isinstance(ltp, (int, float)) and ((side == "bid" and ltp <= price) or (side == "ask" and ltp >= price))
            traded = dvol is not None and dvol >= VOLUME_EXPLAINS * lost
            if w["announced"]:
                events.append({"t": t, "kind": "eaten" if (reached or traded) else "pulled", "side": side, "price": price,
                               "qty": int(lost), "held_s": round((t - w["first"]) / 1000)})
            del self.walls[key]
        return events
