# HeatCharting (NSE)

A live **liquidity heatmap for NSE stocks**: the orders resting in the book are painted behind the candles, so you can see where size is waiting.
This is an original implementation (Python server + TypeScript web app). It contains no code, assets or branding from any other product.

## What works today

| Feature | Detail |
|---|---|
| Symbol search | Any NSE cash equity, by symbol or company name (Angel One instrument list) |
| Candles | One-minute candles for the last 2 days (Angel One), the last candle updates live |
| Liquidity heat | The best five bids (teal) and asks (orange) over time; brighter means more shares resting at that price (log scale) |
| Heat controls | **Heat** button: log or linear colour scale, opacity, a minimum size (hide thin orders), and **walls only** (just the largest tenth of resting orders in view). Saved in your browser, with a Reset |
| Wall tracking | A **wall** is an order at least 3x the median level size (judged over the last ~600 levels). The chart marks when one **appeared** (triangle), was **pulled** (cross, amber) or was **eaten** (solid diamond), and the side panel logs them. Events are stored (7 days) and sent live. *Pulled* is inferred: the order vanished and trading does not explain it. A wall that leaves the five visible levels is dropped silently, never called pulled |
| Timeframes | 1m, 3m, 5m, 15m, 30m, 1h, 4h, D, W. The 4h and weekly bars are built from 1h and daily candles. The depth heat shows on 1m to 1h bars only |
| Chart types | Candles, Heikin Ashi, Bars (OHLC), Line, Area, Baseline |
| Indicators | Volume, SMA, EMA, VWAP (daily reset), Bollinger Bands, RSI, MACD, ATR. Edit periods and colours, remove any; RSI, MACD and ATR get their own panes |
| Compare | Overlay up to 4 other symbols, rebased to start at the main symbol's price |
| Visibility (eye) | Show or hide the heat, wall markers, indicators and compared symbols |
| Alerts | Price alerts drawn as lines on the chart, fired on-screen with a sound and a browser notification when the price reaches the level. They only fire while the page is open |
| Replay | Step or play through past candles at 1x to 30x, with the recorded depth heat and wall events as they were (starts at the latest session's open) |
| Undo / redo | Every layout change (indicators, chart type, timeframe, compares, visibility) |
| Layouts | Save and load named layouts; 1, 2 or 4 charts on screen, each with its own symbol, timeframe and indicators |
| Theme, picture, export | Dark and light theme; save a PNG of the chart with the heat on it; export the candles as CSV |
| Paper trading | **Trade** button: practise buys and sells at the live price with a cash balance, positions, realised and open P&L. Practice only: no order is ever sent to a broker |
| Drawing tools | Left toolbar: cursor, trend line, ray, horizontal line, vertical line, rectangle, Fibonacci retracement, text note and a measure tool (price, percentage, bars and time of a move). Drawings are kept in time and price, so they follow zooming and panning; select, drag, recolour, delete (Delete key), undo and redo (Ctrl+Z, Ctrl+Y), magnet to candle highs and lows, hide all. Saved per symbol in this browser |
| Trade flow | **Flow** menu: footprint (sell x buy at each price inside each bar, with the bar's delta), volume profile (volume at price in view, buy and sell split, point of control marked), plus Delta and Cumulative-delta panes. Zoom buttons (+ and -) and a jump-to-latest button sit on the right of the toolbar |
| Order book panel | The live best-five ladder with quantity bars |
| Recording | Every snapshot is stored in SQLite (7 days), so a refresh or a closed market still shows the last recorded session |
| Honest status | "Live", "No update for N s", or "Waiting for the feed (market closed?)"; unknown values are never shown as zero |

## How trade flow is estimated

Angel One sends one reading about every second with the day's cumulative volume. The volume added between two readings is placed at the last price and
called a **buy** when that price is at or above the previous best ask, a **sell** at or below the previous best bid, otherwise by the price tick, then by
the previous side (and **unclassified** if none applies). Several trades inside one second are lumped together, so this is a guide to who was pushing, not
a tape of every trade. Nothing is invented: a reading without volume or price makes no event, and bars from before recording began show no delta (unknown, not zero).

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

Tests: `pytest tests` (server) and `cd web && npm test` (heat rules). Type check: `cd web && npm run typecheck`.

**One Angel login per client code.** Angel invalidates the older token when a new login happens. If another project uses the same client code, set
`ANGEL_SESSION_FILE` to the same file in both so they share one session (see `.env.example`).

**No login screen.** The server binds to `127.0.0.1`. Do not expose it to the internet as it is.

## Layout

```
server/   app.py (API + WebSocket) · feed.py (Angel depth socket) · angel.py (search, candles) · angel_session.py (shared login)
          heat.py (pure functions) · walls.py (wall tracker) · flow.py (trade flow estimate) · store.py (SQLite)
web/      src/main.ts · heatmap.ts (canvas heat layer on Lightweight Charts) · scale.ts (colour and wall rules) · api.ts · style.css
tests/    test_server.py · test_walls.py · test_flow.py
docs/     FEATURES.md (what is built, what is next)
```

Charts use TradingView's open-source [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0).
