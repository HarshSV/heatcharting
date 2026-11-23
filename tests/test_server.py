import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import heat  # noqa: E402
import store  # noqa: E402

MSG = {"token": "11536", "exchange_timestamp": 1795413393000, "last_traded_price": 247830, "volume_trade_for_the_day": 3871949,
       "best_5_buy_data": [{"flag": 1, "quantity": 42, "price": 247760, "no of orders": 1}, {"flag": 1, "quantity": 1, "price": 247770, "no of orders": 1}],
       "best_5_sell_data": [{"flag": 0, "quantity": 81, "price": 247830, "no of orders": 5}, {"flag": 0, "quantity": 133, "price": 247820, "no of orders": 6}]}


def test_snapshot_converts_paise_and_sorts_best_first():
    s = heat.to_snapshot(MSG)
    assert s["ltp"] == 2478.30 and s["t"] == 1795413393000
    assert s["bids"][0][0] == 2477.70 and s["bids"][1][0] == 2477.60       # best bid first
    assert s["asks"][0][0] == 2478.20 and s["asks"][1][0] == 2478.30       # best ask first


def test_a_message_without_a_book_is_not_a_snapshot():
    assert heat.to_snapshot({"token": "1", "last_traded_price": 100}) is None
    assert heat.to_snapshot("junk") is None


def test_unknown_values_stay_unknown_not_zero():
    s = heat.to_snapshot({"best_5_buy_data": [{"quantity": 5, "price": 10000, "no of orders": "x"}], "last_traded_price": 0})
    assert s["ltp"] is None and s["t"] is None and s["bids"][0][2] is None


def test_rebucket_merges_levels_in_one_bucket():
    got = heat.rebucket([[100.00, 10, 1], [100.05, 5, 2], [100.10, 7, None]], 0.10)
    assert got == [[100.0, 15, 3], [100.1, 7, None]]


def test_tick_size_and_max_quantity():
    assert heat.tick_size([100.0, 100.05, 100.15]) == 0.05 and heat.tick_size([]) == 0.05
    assert heat.max_quantity([heat.to_snapshot(MSG)]) == 133 and heat.max_quantity([]) == 0


def test_store_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", str(tmp_path / "d.db"))
    s = heat.to_snapshot(MSG)
    store.add("TCS", s)
    store.add("TCS", {**s, "t": s["t"] + 60_000})
    assert store.latest_time("TCS") == s["t"] + 60_000
    got = store.since("TCS", s["t"])
    assert [x["t"] for x in got] == [s["t"], s["t"] + 60_000] and got[0]["bids"][0][0] == 2477.70
    assert store.since("TCS", s["t"] + 1)[0]["t"] == s["t"] + 60_000 and store.latest_time("INFY") is None
