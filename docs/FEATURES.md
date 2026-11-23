# Features: built and next

Written from our own requirements for an NSE order-flow chart. Nothing here is copied from another product.

## Built (v1)
- NSE symbol search, one-minute candles, live candle updates
- Liquidity heatmap from the best five bids and asks, with log-scaled colour
- Live order-book ladder
- Depth recording (SQLite, 7 days) and replay of the last session
- Live / quiet / market-closed status

## Next, in this order
1. **Heat controls:** colour scale (linear or log), opacity, a minimum size filter, and a "walls only" view that shows only unusually large orders.
2. **Wall tracking:** mark when a large resting order is pulled or eaten, from changes between snapshots.
3. **Trade flow:** buy and sell volume per price (a footprint view) from the tick stream.
4. **More intervals:** 5-minute and 15-minute candles, and a day-session switch.
5. **Deeper depth:** a second feed (20 or 200 levels) behind the same interface, once a data subscription is chosen.
6. **Option chain** for NSE index and stock options.
7. **Watchlist and alerts** on size appearing, being pulled, or price touching a wall.
8. **Strategy tester and screener** (largest piece, last).

## Known limits
- Five levels per side is thin; the heat shows the near book only.
- Heat exists only for the time the server was running and the symbol was open (it is recorded, not reconstructed).
- Angel allows one session per client code; see README.
