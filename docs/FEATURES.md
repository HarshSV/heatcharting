# Features: built and next

Written from our own requirements for an NSE order-flow chart. Nothing here is copied from another product.

## Built (v1)
- NSE symbol search, one-minute candles, live candle updates
- Liquidity heatmap from the best five bids and asks, with log-scaled colour
- Heat controls: log / linear scale, opacity, minimum size, walls only (largest tenth in view), saved per browser
- Wall tracking: appeared / pulled / eaten, marked on the chart, logged in the side panel, stored and streamed (inferred from five levels, see README)
- Top toolbar: timeframes (1m to weekly), chart types, indicators (volume, SMA, EMA, VWAP, Bollinger, RSI, MACD, ATR), compare, visibility,
  price alerts, replay, undo and redo, saved layouts, 1 / 2 / 4 chart grid, theme, picture, CSV export, paper trading
- Drawing tools: trend line, ray, horizontal and vertical line, rectangle, Fibonacci retracement, text, measure; select, move, recolour, delete, undo and redo, magnet, hide; saved per symbol
- Trade flow: footprint, volume profile (with point of control), delta and cumulative delta panes, estimated from the live depth feed
- Zoom buttons and jump to the latest bar
- Bottom bar: range buttons, IST clock with market badge, percentage / log / auto price scale
- Right panel with an icon rail: order book and walls, watchlist with live quotes, alerts list, data window, objects list
- Live order-book ladder
- Candle loading that survives Angel rate limits (cached for 20 s, retried, and the live feed never waits for it)
- Depth recording (SQLite, 7 days) and replay of the last session
- Live / quiet / market-closed status

## Next, in this order
1. **More intervals:** 5-minute and 15-minute candles, and a day-session switch.
2. **Deeper depth:** a second feed (20 or 200 levels) behind the same interface, once a data subscription is chosen.
3. **Option chain** for NSE index and stock options.
4. **Watchlist and alerts** on size appearing, being pulled, or price touching a wall.
5. **Strategy tester and screener** (largest piece, last).

## Known limits
- The market badge uses weekdays and clock hours only; it does not know NSE trading holidays.
- The watchlist shows prices from Angel One's quote snapshot (refreshed every few seconds), not a live stream.
- Trade flow is an estimate from one-second readings (lumped trades, side from the best bid and ask); it is not a trade-by-trade tape.
- Drawings are not drawn on the lower indicator panes, and Ctrl+Z undoes drawing changes only (the toolbar's undo is for chart settings).
- Alerts are checked in the browser, so they only fire while the page is open (server-side alerts are a later step).
- Paper trading uses the last price seen by the page; it does not model slippage, queue position, charges or margin.
- Compare rebases to the first bar loaded, so a long history can stretch the price axis.
- The depth heat is available for 1m to 1h bars (it is recorded per second, and a day or week bar would hide it).
- Five levels per side is thin; the heat shows the near book only, and "pulled" cannot be told apart from an order that was cancelled and re-placed just outside the five visible levels.
- Heat exists only for the time the server was running and the symbol was open (it is recorded, not reconstructed).
- Angel allows one session per client code; see README.
