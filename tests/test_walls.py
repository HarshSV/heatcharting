import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import walls  # noqa: E402
from walls import WallTracker, wall_threshold  # noqa: E402

BASE = 1_700_000_000_000


def snap(i, bids, asks, ltp=100.0, vol=None):
    return {"t": BASE + i * 1000, "ltp": ltp, "vol": vol, "bids": bids, "asks": asks}


def calm(i, vol=None):
    """Five thin levels each side, quantity 100: the background the walls stand out from."""
    return snap(i, [[99.95 - 0.05 * k, 100, 1] for k in range(5)], [[100.05 + 0.05 * k, 100, 1] for k in range(5)], vol=vol)


def warmed():
    t = WallTracker()
    for i in range(10):                       # 10 snapshots x 10 levels = 100 samples, enough to judge by
        assert t.update(calm(i)) == []
    return t


def with_wall(i, qty, ltp=100.0, vol=None, price=99.90):
    """Calm book but the third bid is `qty` shares."""
    s = calm(i, vol)
    s["bids"][2] = [price, qty, 3]
    s["ltp"] = ltp
    return s


def test_no_wall_is_declared_until_there_is_enough_to_compare_with():
    t = WallTracker()
    assert t.update(with_wall(0, 5000)) == []
    assert wall_threshold([100] * 10) is None and wall_threshold([100] * 60) == 300


def test_a_wall_is_announced_only_after_it_stands_for_a_few_snapshots():
    t = warmed()
    got = []
    for i in range(10, 13):
        got += t.update(with_wall(i, 5000))
    assert [e["kind"] for e in got] == ["appeared"] and got[0]["side"] == "bid" and got[0]["price"] == 99.90 and got[0]["qty"] == 5000


def test_a_wall_that_vanishes_without_trading_is_pulled():
    t = warmed()
    for i in range(10, 14):
        t.update(with_wall(i, 5000, vol=1000))
    ev = t.update(calm(14, vol=1010))                  # almost nothing traded, the order is simply gone
    assert [e["kind"] for e in ev] == ["pulled"] and ev[0]["qty"] >= 4800 and ev[0]["held_s"] >= 3


def test_a_wall_the_price_runs_into_is_eaten():
    t = warmed()
    for i in range(10, 14):
        t.update(with_wall(i, 5000, vol=1000))
    ev = t.update(with_wall(14, 200, ltp=99.90, vol=1100))   # the price came down to the wall and it was consumed
    assert [e["kind"] for e in ev] == ["eaten"]


def test_heavy_volume_explains_a_loss_even_if_the_last_price_is_elsewhere():
    t = warmed()
    for i in range(10, 14):
        t.update(with_wall(i, 5000, vol=1000))
    ev = t.update(calm(14, vol=1000 + 4000))
    assert [e["kind"] for e in ev] == ["eaten"]


def test_a_wall_the_price_has_run_through_downwards_is_eaten():
    t = warmed()
    for i in range(10, 14):
        t.update(with_wall(i, 5000))
    fell = snap(14, [[99.50 - 0.05 * k, 100, 1] for k in range(5)], [[99.60 + 0.05 * k, 100, 1] for k in range(5)], ltp=99.55)
    assert [e["kind"] for e in t.update(fell)] == ["eaten"] and not t.walls


def test_a_wall_that_leaves_the_visible_levels_is_not_called_pulled():
    t = warmed()
    for i in range(10, 14):
        t.update(with_wall(i, 5000))                    # a bid wall at 99.90
    rose = snap(14, [[100.60 - 0.05 * k, 100, 1] for k in range(5)], [[100.70 + 0.05 * k, 100, 1] for k in range(5)], ltp=100.65)
    assert t.update(rose) == [] and not t.walls          # the price moved away: the wall is out of sight, which is unknown, not pulled


def test_a_flicker_of_one_snapshot_is_never_reported():
    t = warmed()
    assert t.update(with_wall(10, 5000)) == []
    assert t.update(calm(11)) == [] and not t.walls
