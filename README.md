# HeatCharting (NSE)

A live **liquidity heatmap for NSE stocks**: the orders resting in the book are painted behind the candles, so you can see where size is waiting.
This is an original implementation (Python server + TypeScript web app). It contains no code, assets or branding from any other product.

## What works today (v1)

| Feature | Detail |
|---|---|
| Symbol search | Any NSE cash equity, by symbol or company name (Angel One instrument list) |
| Candles | One-minute candles for the last 2 days (Angel One), the last candle updates live |
| Liquidity heat | The best five bids (teal) and asks (orange) over time; brighter means more shares resting at that price (log scale) |
| Order book panel | The live best-five ladder with quantity bars |
| Recording | Every snapshot is stored in SQLite (7 days), so a refresh or a closed market still shows the last recorded session |
| Honest status | "Live", "No update for N s", or "Waiting for the feed (market closed?)"; unknown values are never shown as zero |

## The data limit you should know about

Angel One's feed gives only the **five best levels** on each side. A heatmap needs depth, so v1 is thinner than a 20 or 200-level book. The server keeps
the feed behind one module (`server/feed.py`), so a deeper source (for example Dhan's 200-level depth, which needs a Dhan data subscription) can be added
without touching the chart.

## Run it

```bash
cp .env.example .env            # fill in the Angel One credentials
pip install -r server/requirements.txt
cd web && npm install && npm run build && cd ..
python server/app.py            # http://127.0.0.1:8100
```

Development with hot reload: `python server/app.py` and, in `web/`, `npm run dev` (http://localhost:5173, proxied to the server).

Tests: `pytest tests`. Type check: `cd web && npm run typecheck`.

**One Angel login per client code.** Angel invalidates the older token when a new login happens. If another project uses the same client code, set
`ANGEL_SESSION_FILE` to the same file in both so they share one session (see `.env.example`).

**No login screen.** The server binds to `127.0.0.1`. Do not expose it to the internet as it is.

## Layout

```
server/   app.py (API + WebSocket) · feed.py (Angel depth socket) · angel.py (search, candles) · angel_session.py (shared login)
          heat.py (pure functions) · store.py (SQLite)
web/      src/main.ts · heatmap.ts (canvas heat layer on Lightweight Charts) · api.ts · style.css
tests/    test_server.py
docs/     FEATURES.md (what is built, what is next)
```

Charts use TradingView's open-source [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0).
