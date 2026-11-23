import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import store  # noqa: E402
from flow import FlowTracker, classify  # noqa: E402


def snap(t, ltp, vol, bid=100.00, ask=100.05):
    return {"t": t, "ltp": ltp, "vol": vol, "bids": [[bid, 100, 1]] if bid is not None else [], "asks": [[ask, 100, 1]] if ask is not None else []}


def test_a_last_price_at_the_ask_is_a_buy_and_at_the_bid_a_sell():
    prev = snap(0, 100.00, 1000)
    assert classify(prev, snap(1000, 100.05, 1300)) == {"t": 1000, "price": 100.05, "qty": 300, "side": 1}
    assert classify(prev, snap(1000, 100.00, 1200))["side"] == -1


def test_inside_the_spread_the_tick_rule_then_the_previous_side_decide():
    prev = snap(0, 100.02, 1000, bid=100.00, ask=100.06)
    assert classify(prev, snap(1000, 100.04, 1100))["side"] == 1            # price rose, not at the ask
    assert classify(prev, snap(1000, 100.01, 1100))["side"] == -1           # price fell, not at the bid
    assert classify(prev, snap(1000, 100.02, 1100), last_side=-1)["side"] == -1   # unchanged: keep the last side
    assert classify(prev, snap(1000, 100.02, 1100), last_side=0)["side"] == 0     # nothing to go on: unclassified


def test_no_new_volume_or_unknown_inputs_make_no_event():
    prev = snap(0, 100.0, 1000)
    assert classify(prev, snap(1000, 100.0, 1000)) is None
    assert classify(prev, snap(1000, 100.0, 900)) is None                   # a reset or a bad number is ignored, never turned into a trade
    assert classify(prev, snap(1000, None, 1100)) is None
    assert classify(prev, {"t": 1000, "ltp": 100.0, "vol": None, "bids": [], "asks": []}) is None
    assert classify(None, snap(1000, 100.0, 1100)) is None


def test_the_tracker_carries_the_side_across_snapshots():
    t = FlowTracker()
    assert t.update(snap(0, 100.00, 1000)) is None                          # the first snapshot only sets the baseline
    assert t.update(snap(1000, 100.05, 1100))["side"] == 1
    ev = t.update(snap(2000, 100.05, 1150, bid=100.00, ask=100.10))        # inside the spread and unchanged: stays a buy
    assert ev["side"] == 1 and ev["qty"] == 50


def test_flow_is_stored_and_read_back_oldest_first(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", str(tmp_path / "f.db"))
    store.add_flow("TCS", {"t": 2000, "price": 100.1, "qty": 5, "side": -1})
    store.add_flow("TCS", {"t": 1000, "price": 100.0, "qty": 3, "side": 1})
    assert store.flow_since("TCS", 0) == [[1000, 100.0, 3, 1], [2000, 100.1, 5, -1]]
    assert store.flow_since("TCS", 1500) == [[2000, 100.1, 5, -1]] and store.flow_since("INFY", 0) == []
