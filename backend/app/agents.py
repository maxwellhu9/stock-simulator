"""Simulated traders whose orders decide the price.

The old market maker quoted around a mid that random-walked. The price was an
input: a number generator decided it and the book decorated it. Here the price
is an output. Nobody sets it. It is simply whatever the last trade printed at,
and trades happen because agents disagree about what the thing is worth.

Four kinds of trader, each pushing differently:

  value      buys below its estimate of fair value, sells above it. This is the
             anchor -- without it momentum and noise would wander off forever.
  momentum   buys what has been rising, sells what has been falling. Amplifies
             whatever just happened, which is where trends and overshoot come
             from.
  noise      trades for no reason at all. Real markets are full of people
             rebalancing, panicking, or guessing, and that flow is what gives
             the other strategies something to trade against.
  maker      quotes both sides and earns the spread, but skews its quotes when
             it accumulates inventory, because holding a position is risk.

Fair value drifts on its own, slowly. That is the only exogenous input left,
and it stands in for everything a real market reacts to that is not order flow.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from .orderbook import OrderBook, Side


@dataclass
class Intent:
    """An order an agent wants to place. The caller decides whether it can."""

    side: Side
    quantity: int
    price: int | None  # None = market order
    agent: str


@dataclass
class MarketState:
    """What an agent can see. Deliberately only public information."""

    symbol: str
    best_bid: int | None
    best_ask: int | None
    last_price: int
    recent: list[int]  # recent trade prices, oldest first
    # Closing price of each recent tick, oldest first. Trades arrive dozens to
    # a tick, so "the last few trades" spans a fraction of a second; anything
    # reacting to trends needs to look back over time instead.
    tick_prices: list[int] = field(default_factory=list)

    @property
    def mid(self) -> int:
        if self.best_bid is not None and self.best_ask is not None:
            return (self.best_bid + self.best_ask) // 2
        return self.last_price

    @property
    def momentum(self) -> float:
        """Fractional change across the recent window. 0.0 when there is no history."""
        if len(self.recent) < 2:
            return 0.0
        first, last = self.recent[0], self.recent[-1]
        return (last - first) / first if first else 0.0


class Agent:
    """Base class. `act` returns orders to try, and may return none."""

    kind = "agent"

    def __init__(self, name: str, aggression: float = 1.0) -> None:
        self.name = name
        self.aggression = aggression
        self.inventory = 0  # signed, for the agent's own bookkeeping

    def act(self, state: MarketState, book: OrderBook) -> list[Intent]:
        raise NotImplementedError


class ValueTrader(Agent):
    """Thinks the thing is worth `fair`, and trades against any gap.

    The further price strays from fair value the harder it pushes, which is what
    stops the market wandering off. Its estimate is noisy, so value traders
    disagree slightly with each other rather than acting as one block.
    """

    kind = "value"

    def __init__(self, name: str, fair: int, error: float = 0.008,
                 aggression: float = 1.0) -> None:
        super().__init__(name, aggression)
        # Each trader is a little wrong, and wrong in its own direction.
        self.bias = random.gauss(0.0, error)

    def act(self, state: MarketState, book: OrderBook, fair: int = 0) -> list[Intent]:
        my_fair = int(fair * (1.0 + self.bias))
        gap = (my_fair - state.mid) / my_fair if my_fair else 0.0

        # Too close to fair value to be worth chasing. But a value trader does
        # not just wait -- it leaves an order where the price WOULD be a
        # bargain, so it is ready if the market overshoots. This is where real
        # depth comes from: buyers resting below the market and sellers resting
        # above it, each at their own idea of cheap and expensive. Without it,
        # every resting order sits within a few ticks of the last price and a
        # large order simply runs off the end of the book.
        if abs(gap) < 0.002:
            if random.random() > 0.8:
                return []
            size = max(1, int(random.randint(80, 260) * self.aggression))
            margin = 0.003 + random.uniform(0.0, 0.009)
            if random.random() < 0.5:
                return [Intent(Side.BUY, size, int(my_fair * (1 - margin)), self.name)]
            return [Intent(Side.SELL, size, int(my_fair * (1 + margin)), self.name)]

        size = max(1, int(abs(gap) * 4000 * self.aggression))
        size = min(size, 300)

        if gap > 0:  # cheap -> buy, bidding just under fair
            price = min(my_fair, state.mid + max(1, int(state.mid * 0.0006)))
            return [Intent(Side.BUY, size, price, self.name)]
        price = max(my_fair, state.mid - max(1, int(state.mid * 0.0006)))
        return [Intent(Side.SELL, size, price, self.name)]


class MomentumTrader(Agent):
    """Buys what is going up. Sells what is going down.

    Pure feedback: it reacts to price rather than to any notion of worth, so it
    accelerates moves that are already happening and is the reason the market
    overshoots instead of settling instantly.
    """

    kind = "momentum"

    def __init__(self, name: str, threshold: float = 0.0006,
                 aggression: float = 1.0) -> None:
        super().__init__(name, aggression)
        self.threshold = threshold * random.uniform(0.6, 1.6)
        # Each trader watches its own horizon -- a few seconds to ten -- so they
        # do not all pile in on the same tick.
        self.lookback = random.randint(4, 10)
        # How far it will lean in one direction. Without a cap a trend-follower
        # with deep pockets buys forever and a rally never ends; with one, the
        # buying pressure runs out once everyone is fully loaded, and the value
        # traders pull the price back. That is the difference between a boom
        # that busts and a price that runs off to infinity.
        self.max_position = random.randint(80, 200)

    def act(self, state: MarketState, book: OrderBook) -> list[Intent]:
        window = state.tick_prices[-(self.lookback + 1):]
        if len(window) < self.lookback + 1 or not window[0]:
            return []
        m = (window[-1] - window[0]) / window[0]
        if state.best_ask is None or state.best_bid is None:
            return []
        if abs(m) < self.threshold:
            # The trend has faded. A real trend-follower takes profit here
            # rather than sitting on a full position until the price turns --
            # otherwise every momentum bot dumps everything on the first dip,
            # flipping from fully long to fully short at once, and the market
            # rocks back and forth in big regular waves.
            if abs(self.inventory) < 10:
                return []
            size = min(abs(self.inventory) // 4 + 1, 40)
            if self.inventory > 0:
                return [Intent(Side.SELL, size, state.best_bid, self.name)]
            return [Intent(Side.BUY, size, state.best_ask, self.name)]

        size = int(min(abs(m) * 5000, 40) * self.aggression)
        room = (self.max_position - self.inventory if m > 0
                else self.max_position + self.inventory)
        size = min(size, room)
        if size <= 0:
            return []  # fully committed in this direction already
        # Crosses the spread -- it wants in now, not at a better price later.
        if m > 0:
            return [Intent(Side.BUY, size, state.best_ask, self.name)]
        return [Intent(Side.SELL, size, state.best_bid, self.name)]


class NoiseTrader(Agent):
    """Trades for no reason. Someone is always rebalancing or guessing."""

    kind = "noise"

    def __init__(self, name: str, rate: float = 0.35,
                 aggression: float = 1.0) -> None:
        super().__init__(name, aggression)
        self.rate = rate

    def act(self, state: MarketState, book: OrderBook) -> list[Intent]:
        if random.random() > self.rate:
            return []

        side = random.choice([Side.BUY, Side.SELL])
        size = max(1, int(random.randint(5, 120) * self.aggression))

        # Mostly rests inside the spread; occasionally takes liquidity outright.
        if random.random() < 0.3:
            return [Intent(side, size, None, self.name)]
        offset = random.randint(1, max(2, int(state.mid * 0.0015)))
        price = state.mid + offset if side is Side.SELL else state.mid - offset
        return [Intent(side, size, max(1, price), self.name)]


class MarketMakerAgent(Agent):
    """Quotes both sides and tries to end the day flat.

    Earning the spread is easy; the hard part is inventory. Every fill leaves it
    holding something, and holding is risk. So it skews: long inventory pushes
    both quotes down to encourage selling, short pushes them up. That skew is a
    real force on the price, not a cosmetic detail.
    """

    kind = "maker"

    def __init__(self, name: str, half_spread: float = 0.00025,
                 levels: int = 3, aggression: float = 1.0) -> None:
        super().__init__(name, aggression)
        self.half_spread = half_spread
        self.levels = levels
        self.resting: list[int] = []  # order ids, pulled before requoting

    def act(self, state: MarketState, book: OrderBook) -> list[Intent]:
        mid = state.mid
        half = max(1, int(mid * self.half_spread))
        step = max(1, int(mid * 0.0005))

        # Lean against inventory: long -> quote lower, short -> quote higher.
        skew = int(-self.inventory * 0.02)

        out: list[Intent] = []
        for i in range(self.levels):
            size = max(1, int(random.randint(40, 180) * self.aggression))
            out.append(Intent(Side.BUY, size, mid - half - i * step + skew, self.name))
            out.append(Intent(Side.SELL, size, mid + half + i * step + skew, self.name))
        return out


@dataclass
class Population:
    """How many of each kind of trader are in the market right now."""

    value: int = 6
    momentum: int = 5
    noise: int = 8
    maker: int = 2

    def total(self) -> int:
        return self.value + self.momentum + self.noise + self.maker


def build_population(pop: Population, fair: int) -> list[Agent]:
    """Create the agent objects for a population. Names are stable per slot."""
    agents: list[Agent] = []
    values = [ValueTrader(f"value_{i}", fair) for i in range(pop.value)]
    # Each value trader is wrong in its own direction, which is what makes them
    # disagree and trade with each other. But with only a handful of them, the
    # AVERAGE error lands a few tenths of a percent off by pure chance, and the
    # whole market then settles there instead of at fair value. Centering keeps
    # the disagreement and removes the accidental collective bias.
    if values:
        mean_bias = sum(v.bias for v in values) / len(values)
        for v in values:
            v.bias -= mean_bias
    agents.extend(values)
    for i in range(pop.momentum):
        agents.append(MomentumTrader(f"momentum_{i}"))
    for i in range(pop.noise):
        agents.append(NoiseTrader(f"noise_{i}"))
    for i in range(pop.maker):
        agents.append(MarketMakerAgent(f"maker_{i}"))
    return agents
