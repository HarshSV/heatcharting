import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import quotes  # noqa: E402


def test_a_full_quote_becomes_the_pages_numbers():
    q = quotes.parse({"ltp": 2480.0, "close": 2400.0, "open": 2410, "high": 2490, "low": 2405, "tradeVolume": 123456, "upperCircuit": 2640, "lowerCircuit": 2160}, "TCS")
    assert q["symbol"] == "TCS" and q["change"] == 80.0 and round(q["change_pct"], 4) == round(80 / 2400 * 100, 4)
    assert q["volume"] == 123456 and q["upper_circuit"] == 2640.0 and q["week52_high"] is None


def test_unknown_values_stay_unknown_not_zero():
    q = quotes.parse({"ltp": 100.0}, "X")
    assert q["prev_close"] is None and q["change"] is None and q["change_pct"] is None and q["volume"] is None
    assert quotes.parse({"ltp": 100.0, "close": 0}, "X")["change_pct"] is None        # no percentage from a zero base
    assert quotes.parse({"ltp": "bad", "close": 5}, "X")["ltp"] is None and quotes.parse({}, "X")["change"] is None
