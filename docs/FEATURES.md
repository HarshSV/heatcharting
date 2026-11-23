# Features: built and next

Written from our own requirements for an NSE order-flow chart. Nothing here is copied from another product.

## Built (v1)
- NSE symbol search, one-minute candles, live candle updates
- Liquidity heatmap from the best five bids and asks, with log-scaled colour
- Heat controls: log / linear scale, opacity, minimum size, walls only (largest tenth in view), saved per browser
- Live order-book ladder
- Candle loading that survives Angel rate limits (cached for 20 s, retried, and the live feed never waits for it)
- Depth recording (SQLite, 7 days) and replay of the last session
- Live / quiet / market-closed status

## Next, in this order
1. **Wall tracking:** mark when a large resting order is pulled or eaten, from changes between snapshots.
2. **Trade flow:** buy and sell volume per price (a footprint view) from the tick stream.
3. **More intervals:** 5-minute and 15-minute candles, and a day-session switch.
4. **Deeper depth:** a second feed (20 or 200 levels) behind the same interface, once a data subscription is chosen.
5. **Option chain** for NSE index and stock options.
6. **Watchlist and alerts** on size appearing, being pulled, or price touching a wall.
7. **Strategy tester and screener** (largest piece, last).

## Known limits
- Five levels per side is thin; the heat shows the near book only.
- Heat exists only for the time the server was running and the symbol was open (it is recorded, not reconstructed).
- Angel allows one session per client code; see README.
