"""News and scenarios: things that happen TO the market.

News changes what a stock is worth, all at once. Nothing else changes directly
-- the bots still have to discover the new value by trading, which is the whole
point of watching it. Value traders see it first, momentum traders pile in once
the price starts moving, and the overshoot or lag is whatever the crowd makes it.

Scenarios are short scripts: a few steps on a timer, then the market is put back
the way it was. They are defined as data so adding one is a few lines, not a
new code path.

Headlines are generic on purpose. The tickers are real companies, so nothing
here should read like a real news story about them.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable

from .agents import Population
from .orderbook import Side

if TYPE_CHECKING:
    from sqlmodel import Session

    from .market_sim import MarketSim


@dataclass(frozen=True)
class MarketEvent:
    t: float
    symbol: str | None      # None means the whole market
    kind: str               # "good", "bad" or "scenario"
    headline: str
    impact: float = 0.0     # fractional change to fair value, for news


# (headline, smallest move, largest move). Moves are fractions of fair value.
GOOD_NEWS = [
    ("Earnings beat expectations", 0.020, 0.040),
    ("New product launch gets strong early reviews", 0.012, 0.025),
    ("Analysts upgrade the stock", 0.010, 0.020),
    ("Wins a major long-term contract", 0.018, 0.035),
    ("Announces a large share buyback", 0.010, 0.020),
]
BAD_NEWS = [
    ("Earnings miss expectations", 0.025, 0.045),
    ("CEO steps down unexpectedly", 0.020, 0.035),
    ("Regulators open an investigation", 0.020, 0.040),
    ("Announces a product recall", 0.015, 0.030),
    ("Analysts downgrade the stock", 0.010, 0.020),
]


def draw_news(good: bool, avoid: set[str] = frozenset()) -> tuple[str, float]:
    pool = GOOD_NEWS if good else BAD_NEWS
    # The same headline three times running reads as fake, so skip recent ones.
    fresh = [n for n in pool if n[0] not in avoid] or pool
    headline, lo, hi = random.choice(fresh)
    move = random.uniform(lo, hi)
    return headline, move if good else -move


@dataclass(frozen=True)
class Step:
    after: float                                   # seconds after the start
    run: Callable[["MarketSim", "Session", str], None]
    log: str | None = None                         # shown in the event feed


@dataclass(frozen=True)
class Scenario:
    key: str
    name: str
    description: str
    duration: float                                # then the market is restored
    steps: tuple[Step, ...] = field(default_factory=tuple)


def _crowd(**kw) -> Callable[["MarketSim", "Session", str], None]:
    def run(sim: "MarketSim", session: "Session", symbol: str) -> None:
        base = sim.population
        pop = Population(
            value=kw.get("value", base.value), momentum=kw.get("momentum", base.momentum),
            noise=kw.get("noise", base.noise), maker=kw.get("maker", base.maker),
        )
        sim.set_population(session, pop)
    return run


def _mood(x: float) -> Callable[["MarketSim", "Session", str], None]:
    def run(sim: "MarketSim", session: "Session", symbol: str) -> None:
        sim.sentiment = x
    return run


def _news(good: bool) -> Callable[["MarketSim", "Session", str], None]:
    def run(sim: "MarketSim", session: "Session", symbol: str) -> None:
        sim.news(symbol, good=good)
    return run


def _sell(qty: int, floor: float) -> Callable[["MarketSim", "Session", str], None]:
    # Sells down to `floor` below the market rather than at any price. Once the
    # bids are gone the rest sits there, and buyers trade against it far below
    # the last price -- which is what a flash crash actually is. A plain market
    # order would just stop when the book ran out, a fraction of a percent down.
    def run(sim: "MarketSim", session: "Session", symbol: str) -> None:
        sim.shock(session, symbol, Side.SELL, qty, floor=floor)
    return run


SCENARIOS: dict[str, Scenario] = {s.key: s for s in [
    Scenario(
        "bubble", "Bubble",
        "Good news, then the crowd fills with trend-chasers and everyone gets optimistic.",
        duration=60,
        steps=(
            Step(0, _news(True)),
            Step(0, _crowd(value=2, momentum=20), "Trend-chasers pour in"),
            Step(0, _mood(0.7)),
        ),
    ),
    Scenario(
        "flash_crash", "Flash crash",
        "Market makers pull out, then a huge seller hits the empty book.",
        duration=15,
        steps=(
            Step(0, _crowd(maker=0), "Market makers pull their quotes"),
            Step(2, _sell(3_000, 0.06), "A huge seller hits the book"),
        ),
    ),
    Scenario(
        "panic", "Panic",
        "Bad news, the mood sours, and trend-chasers pile into the drop.",
        duration=45,
        steps=(
            Step(0, _news(False)),
            Step(0, _mood(-0.7)),
            Step(1, _crowd(momentum=14), "Sellers start piling on"),
        ),
    ),
]}
