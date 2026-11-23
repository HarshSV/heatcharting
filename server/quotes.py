"""Quotes for the watchlist and the data window: Angel One's market-data snapshot, reduced to the numbers the page shows.

Unknown stays unknown: a field Angel does not send is None, never 0, and a percentage change is only given when the previous close is a positive number."""
from __future__ import annotations


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v else None


def parse(item: dict, symbol: str) -> dict:
    """One entry of getMarketData("FULL") -> the page's quote."""
    ltp = _num(item.get("ltp"))
    prev = _num(item.get("close"))
    change = ltp - prev if ltp is not None and prev is not None else None
    pct = change / prev * 100.0 if change is not None and prev and prev > 0 else None
    return {
        "symbol": symbol,
        "ltp": ltp,
        "prev_close": prev,
        "change": round(change, 4) if change is not None else None,
        "change_pct": round(pct, 4) if pct is not None else None,
        "open": _num(item.get("open")),
        "high": _num(item.get("high")),
        "low": _num(item.get("low")),
        "volume": _num(item.get("tradeVolume") if item.get("tradeVolume") is not None else item.get("volume")),
        "upper_circuit": _num(item.get("upperCircuit")),
        "lower_circuit": _num(item.get("lowerCircuit")),
        "week52_high": _num(item.get("52WeekHigh")),
        "week52_low": _num(item.get("52WeekLow")),
        "avg_price": _num(item.get("avgPrice")),
    }
