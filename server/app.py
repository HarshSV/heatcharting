"""HeatCharting server: NSE liquidity heatmap data for the browser.

  GET  /api/health                    status of the Angel login and the live feed
  GET  /api/search?q=                 NSE companies by symbol or name
  GET  /api/candles?symbol=&interval=&days=  candles (Angel One: ONE_MINUTE .. ONE_DAY; 4h and weekly are built from 1h and daily in the browser)
  GET  /api/snapshots?symbol=&minutes=  recorded depth snapshots (best five bids and asks over time)
  GET  /api/quotes?symbols=A,B      live quotes (last price, change, high, low, volume, circuits) for the watchlist and data window
  GET  /api/walls?symbol=&minutes=    wall events: a large resting order appeared, was pulled, or was eaten
  GET  /api/flow?symbol=&minutes=     estimated trade flow: price, quantity and side of the volume between snapshots
  WS   /ws?symbol=                    live messages: {"type":"snap",...} depth snapshots and {"type":"wall",...} wall events

Run:  python server/app.py   (serves the built web app from web/dist as well). Binds to 127.0.0.1 unless HEATCHART_HOST says otherwise:
there is no login, so do not expose it to the internet as it is."""
from __future__ import annotations

import asyncio
import os
import sys
import time
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv

load_dotenv(os.environ.get("HEATCHART_ENV") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

import angel
import angel_session
import feed
import store
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

WEB_DIST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "dist")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        store.prune()
    except Exception as e:
        print(f"[server] prune skipped: {e}", flush=True)
    feed.hub.start(asyncio.get_running_loop())
    yield
    feed.hub.stop()


app = FastAPI(title="HeatCharting", lifespan=lifespan)


def _stock(symbol: str) -> dict:
    s = angel.resolve(symbol)
    if not s:
        raise HTTPException(status_code=404, detail=f"Unknown NSE symbol {symbol!r}.")
    return s


@app.get("/api/health")
def health():
    return {"angel_configured": angel_session._creds() is not None, "feed_connected": feed.hub.connected,
            "last_message_age_s": round(time.time() - feed.hub.last_msg, 1) if feed.hub.last_msg else None}


@app.get("/api/search")
def search(q: str = ""):
    return angel.search(q)


@app.get("/api/candles")
def candles(symbol: str, days: int = 2, interval: str = "ONE_MINUTE"):
    s = _stock(symbol)
    try:
        return {"symbol": s["symbol"], "interval": interval, "candles": angel.candles(s["token"], days, interval)}
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/snapshots")
def snapshots(symbol: str, minutes: int = 90):
    """Snapshots from the last `minutes` of the most recent recorded session (so a closed market still shows its last session)."""
    s = _stock(symbol)
    last = store.latest_time(s["symbol"])
    if last is None:
        return {"symbol": s["symbol"], "snapshots": [], "note": "Nothing recorded yet for this symbol. Open it during market hours."}
    return {"symbol": s["symbol"], "snapshots": store.since(s["symbol"], last - max(1, min(minutes, 600)) * 60_000)}


@app.get("/api/quotes")
def quotes(symbols: str):
    """Live quotes for a comma-separated list of NSE symbols (at most 40)."""
    names = [x.strip().upper() for x in symbols.split(",") if x.strip()]
    if not names:
        return {"quotes": {}}
    try:
        return {"quotes": angel.quotes(names)}
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/walls")
def walls(symbol: str, minutes: int = 90):
    """Wall events (appeared, pulled, eaten) from the last `minutes` of the most recent recorded session."""
    s = _stock(symbol)
    last = store.latest_time(s["symbol"])
    if last is None:
        return {"symbol": s["symbol"], "events": []}
    return {"symbol": s["symbol"], "events": store.walls_since(s["symbol"], last - max(1, min(minutes, 600)) * 60_000)}


@app.get("/api/flow")
def flow(symbol: str, minutes: int = 120):
    """Estimated trade flow [t, price, qty, side] (side 1 buy, -1 sell, 0 unclassified) for the last `minutes` of the latest recorded session."""
    s = _stock(symbol)
    last = store.latest_time(s["symbol"])
    if last is None:
        return {"symbol": s["symbol"], "events": []}
    return {"symbol": s["symbol"], "events": store.flow_since(s["symbol"], last - max(1, min(minutes, 600)) * 60_000)}


@app.websocket("/ws")
async def live(ws: WebSocket, symbol: str):
    await ws.accept()
    s = angel.resolve(symbol)
    if not s:
        await ws.close(code=4404)
        return
    q = feed.hub.subscribe(s["symbol"], s["token"])
    try:
        while True:
            await ws.send_json(await q.get())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        feed.hub.unsubscribe(s["symbol"], q)


if os.path.isdir(WEB_DIST):
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HEATCHART_HOST", "127.0.0.1"), port=int(os.environ.get("HEATCHART_PORT", "8100")))
