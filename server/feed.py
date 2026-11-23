"""Live depth from Angel One's SmartWebSocketV2 (snap-quote mode: last price plus the best five bids and asks), shared by every browser.

One socket serves all symbols. Browsers subscribe through `Hub`; each snapshot is recorded to SQLite and pushed to the subscribers. The socket
reconnects by itself, and refreshes the shared login when Angel rejects the token."""
from __future__ import annotations

import asyncio
import os
import threading
import time

import angel_session
import heat
import store
from walls import WallTracker

EXCHANGE_NSE_CM = 1
SNAP_QUOTE = 3


class Hub:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.subs: dict[str, set] = {}          # symbol -> queues of connected browsers
        self.tokens: dict[str, str] = {}        # symbol -> Angel token
        self.by_token: dict[str, str] = {}
        self.trackers: dict[str, WallTracker] = {}
        self.ws = None
        self.connected = False
        self.last_msg = 0.0
        self.lock = threading.Lock()
        self._stop = False

    # ---- browsers ----
    def subscribe(self, symbol: str, token: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        with self.lock:
            first = not self.subs.get(symbol)
            self.subs.setdefault(symbol, set()).add(q)
            self.tokens[symbol] = token
            self.by_token[token] = symbol
        if first:
            self._ws_subscribe(token)
        return q

    def unsubscribe(self, symbol: str, q: asyncio.Queue) -> None:
        with self.lock:
            self.subs.get(symbol, set()).discard(q)
            empty = not self.subs.get(symbol)
            token = self.tokens.get(symbol)
        if empty and token:
            self._ws_unsubscribe(token)

    def _publish(self, symbol: str, snap: dict) -> None:
        if not self.loop:
            return
        for q in list(self.subs.get(symbol, ())):
            def put(q=q):
                if q.full():
                    try:
                        q.get_nowait()          # a slow browser drops its oldest snapshot rather than the feed stalling
                    except asyncio.QueueEmpty:
                        pass
                q.put_nowait(snap)
            self.loop.call_soon_threadsafe(put)

    # ---- the Angel socket ----
    def _on_data(self, _w, msg) -> None:
        self.last_msg = time.time()
        symbol = self.by_token.get(str(msg.get("token"))) if isinstance(msg, dict) else None
        snap = heat.to_snapshot(msg) if symbol else None
        if not snap:
            return
        if snap["t"] is None:
            snap["t"] = int(time.time() * 1000)
        try:
            store.add(symbol, snap)
        except Exception as e:
            print(f"[feed] could not record {symbol}: {e}", flush=True)
        self._publish(symbol, {**snap, "type": "snap"})
        try:
            for ev in self.trackers.setdefault(symbol, WallTracker()).update(snap):
                store.add_wall(symbol, ev)
                self._publish(symbol, {**ev, "type": "wall"})
        except Exception as e:
            print(f"[feed] wall tracking failed for {symbol}: {e}", flush=True)

    def _ws_subscribe(self, token: str) -> None:
        if self.ws and self.connected:
            try:
                self.ws.subscribe("heat", SNAP_QUOTE, [{"exchangeType": EXCHANGE_NSE_CM, "tokens": [token]}])
            except Exception as e:
                print(f"[feed] subscribe failed: {e}", flush=True)

    def _ws_unsubscribe(self, token: str) -> None:
        if self.ws and self.connected:
            try:
                self.ws.unsubscribe("heat", SNAP_QUOTE, [{"exchangeType": EXCHANGE_NSE_CM, "tokens": [token]}])
            except Exception:
                pass

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        threading.Thread(target=self._run, daemon=True, name="angel-depth").start()

    def stop(self) -> None:
        self._stop = True
        try:
            if self.ws:
                self.ws.close_connection()
        except Exception:
            pass

    def _run(self) -> None:
        from SmartApi.smartWebSocketV2 import SmartWebSocketV2
        delay = 3
        while not self._stop:
            sc, ts = angel_session.ensure()
            s = angel_session._read()
            if sc is None or not s:
                print("[feed] Angel login unavailable; retrying", flush=True)
                time.sleep(min(delay, 60))
                delay = min(delay * 2, 60)
                continue
            ws = SmartWebSocketV2(s["jwt"], os.getenv("ANGEL_API_KEY"), s["client"], s["feed"])
            self.ws = ws
            opened = threading.Event()

            def on_open(_w, ws=ws, opened=opened):
                self.connected = True
                opened.set()
                with self.lock:
                    toks = [t for sym, t in self.tokens.items() if self.subs.get(sym)]
                if toks:
                    ws.subscribe("heat", SNAP_QUOTE, [{"exchangeType": EXCHANGE_NSE_CM, "tokens": toks}])
                print(f"[feed] connected, {len(toks)} symbol(s) subscribed", flush=True)

            def on_error(_w, *e):
                print(f"[feed] socket error: {e}", flush=True)

            ws.on_open, ws.on_data, ws.on_error = on_open, self._on_data, on_error
            try:
                ws.connect()                    # blocks until the socket closes
            except Exception as e:
                print(f"[feed] socket ended: {e}", flush=True)
            self.connected = False
            if self._stop:
                break
            # a closed socket is usually an expired or replaced token: make sure the shared login is fresh before reconnecting
            angel_session.ensure(bad_ts=ts)
            time.sleep(delay)
            delay = 3 if opened.is_set() else min(delay * 2, 60)


hub = Hub()
