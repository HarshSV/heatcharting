"""Angel One helpers: the shared login, the instrument list (search) and one-minute candles."""
from __future__ import annotations

import datetime as dt
import json
import os
import threading
import time

import requests

import angel_session

SCRIP_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
SCRIP_CACHE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "scrip_master.json")
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
_lock = threading.Lock()
_equities: list[dict] | None = None
_client = {"sc": None, "ts": 0.0}


def _load_equities() -> list[dict]:
    """NSE cash equities ('-EQ' series) from Angel's instrument list, cached on disk for a day."""
    global _equities
    with _lock:
        if _equities is not None:
            return _equities
        fresh = os.path.exists(SCRIP_CACHE) and time.time() - os.path.getmtime(SCRIP_CACHE) < 86400
        if fresh:
            with open(SCRIP_CACHE, encoding="utf-8") as fh:
                rows = json.load(fh)
        else:
            rows = requests.get(SCRIP_URL, timeout=90).json()
            rows = [r for r in rows if r.get("exch_seg") == "NSE" and str(r.get("symbol", "")).endswith("-EQ")]
            os.makedirs(os.path.dirname(SCRIP_CACHE), exist_ok=True)
            with open(SCRIP_CACHE, "w", encoding="utf-8") as fh:
                json.dump(rows, fh)
        _equities = [{"symbol": r["symbol"][:-3], "name": r.get("name") or r["symbol"][:-3], "token": str(r["token"])} for r in rows]
        return _equities


def search(q: str, limit: int = 12) -> list[dict]:
    """Companies whose symbol or name matches: exact symbol first, then prefix, then contains."""
    q = q.strip().upper()
    if not q:
        return []
    ranked = []
    for r in _load_equities():
        sym, name = r["symbol"].upper(), r["name"].upper()
        rank = 0 if sym == q else 1 if sym.startswith(q) else 2 if q in sym else 3 if q in name else None
        if rank is not None:
            ranked.append((rank, len(sym), r))
    ranked.sort(key=lambda x: (x[0], x[1]))
    return [r for _, _, r in ranked[:limit]]


def resolve(symbol: str) -> dict | None:
    s = symbol.strip().upper()
    return next((r for r in _load_equities() if r["symbol"].upper() == s), None)


def client():
    """The shared Angel REST client."""
    sc, ts = angel_session.ensure()
    if sc is not None:
        _client["sc"], _client["ts"] = sc, ts
    return _client["sc"]


def candles(token: str, days: int = 2, interval: str = "ONE_MINUTE") -> list[dict]:
    """Candles for the last `days` calendar days as [{time (UTC seconds), open, high, low, close, volume}], oldest first.
    Angel caps one request at about 30 days of one-minute data."""
    now = dt.datetime.now(IST)
    payload = {"exchange": "NSE", "symboltoken": token, "interval": interval,
               "fromdate": (now - dt.timedelta(days=min(days, 25))).strftime("%Y-%m-%d 09:15"), "todate": now.strftime("%Y-%m-%d %H:%M")}
    sc = client()
    if sc is None:
        raise RuntimeError("Angel One is not available (check the credentials in .env)")
    res = sc.getCandleData(payload)
    if angel_session.is_invalid_token(res):
        sc, _ = angel_session.ensure(bad_ts=_client["ts"])
        res = sc.getCandleData(payload) if sc else res
    if not isinstance(res, dict) or res.get("status") is not True:
        raise RuntimeError(f"Angel candle request failed: {(res or {}).get('message') if isinstance(res, dict) else res}")
    out = []
    for ts, o, h, l, c, v in res.get("data") or []:
        out.append({"time": int(dt.datetime.fromisoformat(ts).timestamp()), "open": o, "high": h, "low": l, "close": c, "volume": v})
    return out
