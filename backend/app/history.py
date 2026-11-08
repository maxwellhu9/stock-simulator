"""Made-up price history from before the market started.

The market only exists from the moment it first runs, so a one-year chart would
otherwise be empty. This walks backwards from the first real price, with a
fresh random step per point, so the invented past joins the real data with no
gap. Steps get coarser further back: fine detail for the last hour, one point
a day for years ago. That is all a chart of each range can show anyway.

Seeded by symbol, so a stock keeps the same past every time the server starts.
Nothing here is a real price, and none of it is ever traded against.
"""

from __future__ import annotations

import math
import random

# (seconds per step, number of steps, typical size of one step)
LAYERS = [
    (15, 240, 0.0040),          # the hour before the market started
    (300, 276, 0.0040),         # the rest of that day
    (3_600, 2_136, 0.0055),     # back to about three months
    (86_400, 1_735, 0.0150),    # back to five years
]
DAILY_DRIFT = 0.00046           # stocks tend to rise, so the past sits lower


def make_history(symbol: str, start: float, price: int) -> list[tuple[int, int]]:
    """(time, cents) points ending just before `start`, oldest first."""
    rng = random.Random(symbol)
    out: list[tuple[int, int]] = []
    t = start
    log_price = math.log(price)
    calm = 0.0  # volatility comes in stretches, not evenly
    for seconds, steps, size in LAYERS:
        for _ in range(steps):
            calm = 0.97 * calm + rng.gauss(0.0, 0.12)
            step = rng.gauss(0.0, size * math.exp(calm))
            if rng.random() < 0.015:  # the odd earnings-sized jump
                step += rng.gauss(0.0, size * 4)
            log_price -= step + DAILY_DRIFT * seconds / 86_400
            t -= seconds
            out.append((int(t), max(100, round(math.exp(log_price)))))
    out.reverse()
    return out
