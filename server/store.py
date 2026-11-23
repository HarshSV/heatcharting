"""SQLite record of depth snapshots, so the heatmap can be reloaded after a refresh and replayed after the market closes."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

DB_PATH = os.environ.get("HEATCHART_DB") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "depth.db")
KEEP_DAYS = 7
_lock = threading.Lock()


def _con() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE IF NOT EXISTS snaps (sym TEXT NOT NULL, t INTEGER NOT NULL, ltp REAL, vol REAL, bids TEXT, asks TEXT)")
    con.execute("CREATE INDEX IF NOT EXISTS snaps_sym_t ON snaps (sym, t)")
    con.execute("CREATE TABLE IF NOT EXISTS walls (sym TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, qty INTEGER, held_s INTEGER)")
    con.execute("CREATE INDEX IF NOT EXISTS walls_sym_t ON walls (sym, t)")
    return con


def add(sym: str, snap: dict) -> None:
    if snap.get("t") is None:
        return
    with _lock, _con() as con:
        con.execute("INSERT INTO snaps VALUES (?,?,?,?,?,?)", (sym, snap["t"], snap.get("ltp"), snap.get("vol"),
                                                                 json.dumps(snap["bids"]), json.dumps(snap["asks"])))


def latest_time(sym: str) -> int | None:
    with _lock, _con() as con:
        r = con.execute("SELECT MAX(t) FROM snaps WHERE sym=?", (sym,)).fetchone()
    return r[0] if r and r[0] else None


def since(sym: str, t0: int, limit: int = 20000) -> list[dict]:
    with _lock, _con() as con:
        rows = con.execute("SELECT t, ltp, vol, bids, asks FROM snaps WHERE sym=? AND t>=? ORDER BY t LIMIT ?", (sym, t0, limit)).fetchall()
    return [{"t": t, "ltp": ltp, "vol": vol, "bids": json.loads(b), "asks": json.loads(a)} for t, ltp, vol, b, a in rows]


def prune(days: int = KEEP_DAYS) -> int:
    cutoff = int((time.time() - days * 86400) * 1000)
    with _lock, _con() as con:
        con.execute("DELETE FROM walls WHERE t<?", (cutoff,))
        return con.execute("DELETE FROM snaps WHERE t<?", (cutoff,)).rowcount


def add_wall(sym: str, ev: dict) -> None:
    with _lock, _con() as con:
        con.execute("INSERT INTO walls VALUES (?,?,?,?,?,?,?)", (sym, ev["t"], ev["kind"], ev["side"], ev["price"], ev.get("qty"), ev.get("held_s")))


def walls_since(sym: str, t0: int, limit: int = 2000) -> list[dict]:
    with _lock, _con() as con:
        rows = con.execute("SELECT t, kind, side, price, qty, held_s FROM walls WHERE sym=? AND t>=? ORDER BY t LIMIT ?", (sym, t0, limit)).fetchall()
    return [{"t": t, "kind": k, "side": sd, "price": p, "qty": q, "held_s": h} for t, k, sd, p, q, h in rows]
