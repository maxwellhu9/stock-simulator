"""Runs the agents against the real exchange, so the price emerges from trading.

Every order here goes through the same `Exchange.place_order` a human uses --
same affordability checks, same matching engine, same settlement. The agents get
no special path. If they could not afford it, they do not get it.

That matters for what the price means. It is not computed anywhere. It is simply
the last price two agents agreed on, and it moves because the balance of who
wants to buy and who wants to sell changed.

Fair value is the one exogenous input: a slow drift standing in for everything a
real market reacts to that is not order flow. Agents cannot see it directly --
value traders each hold their own noisy estimate of it.
"""

from __future__ import annotations

import math
import random
import time
from collections import deque
from dataclasses import dataclass

from sqlmodel import Session, select

from .agents import (
    Agent,
    Intent,
    MarketMakerAgent,
    MarketState,
    Population,
    ValueTrader,
    build_population,
)
from .exchange import Exchange, ExchangeError
from .models import Account, OrderRecord, OrderStatus, Position, TradeRecord
from .orderbook import OrderBook, Side

# Agent accounts are namespaced so they can never collide with a real user.
PREFIX = "sim"

AGENT_CASH = 2_000_000_00   # $2M each
AGENT_SHARES = 20_000       # enough that they can sell without a borrow
FAIR_VOL = 0.0007           # long-run size of fair-value moves, per sqrt(tick)
FAIR_PERSIST = 0.95         # how much of last tick's drift carries into this one
RECENT_WINDOW = 12          # trades the momentum traders can see
ACT_FRACTION = 0.55         # share of agents that act on any given tick
ORDER_TTL = 8               # ticks before an unfilled agent order is pulled
HISTORY = 900               # (time, price, fair) samples kept per symbol


@dataclass(frozen=True)
class ShockResult:
    """What a large order did to the book.

    Plain values, not database rows: this is computed before the commit and
    stays valid after it. Returning ORM objects from a function that commits
    hands the caller rows whose attributes have already been expired.

    `filled` matters as much as the price move. A market order that runs out of
    book just stops -- so on a thin book the price barely moves, not because the
    market absorbed the order, but because most of it never executed.
    """

    side: str
    requested: int
    filled: int
    mid_before: int
    avg_fill: int
    last_fill: int
    orders_hit: int

    @property
    def fill_rate(self) -> float:
        return self.filled / self.requested if self.requested else 0.0

    @property
    def slippage(self) -> float:
        """Average fill vs. the mid just before, as a fraction. Negative = worse for a seller."""
        return (self.avg_fill - self.mid_before) / self.mid_before if self.mid_before else 0.0


# Last-resort prices, in cents, if the network is unavailable at startup. Real
# values are fetched once and overwrite these.
FALLBACK_PRICES: dict[str, int] = {
    "AAPL": 23150,
    "NVDA": 18420,
    "MSFT": 51075,
}


def fetch_real_prices(symbols: list[str]) -> dict[str, int]:
    """One-shot real prices. Falls back silently -- this must never block startup."""
    prices = dict(FALLBACK_PRICES)
    try:
        import yfinance as yf

        for sym in symbols:
            try:
                last = float(yf.Ticker(sym).fast_info.last_price)
                if last > 0:
                    prices[sym] = int(round(last * 100))
            except Exception:
                continue
    except Exception:
        pass
    return {s: prices.get(s, 10000) for s in symbols}


def last_traded(session: Session, symbols: list[str]) -> dict[str, int]:
    """The most recent trade price per symbol, for symbols that have traded."""
    out: dict[str, int] = {}
    for sym in symbols:
        t = session.exec(
            select(TradeRecord).where(TradeRecord.symbol == sym)
            .order_by(TradeRecord.id.desc())
        ).first()
        if t is not None:
            out[sym] = t.price_cents
    return out


def account_name(symbol: str, agent: str) -> str:
    return f"{PREFIX}:{symbol}:{agent}"


class MarketSim:
    def __init__(self, books: dict[str, OrderBook], fair: dict[str, int]) -> None:
        self.books = books
        self.fair = dict(fair)
        self.last: dict[str, int] = dict(fair)
        self.recent: dict[str, list[int]] = {s: [] for s in fair}
        self.population = Population()
        # -1 bearish, 0 neutral, +1 bullish. Biases the drift in fair value.
        self.sentiment = 0.0
        self.agents: dict[str, list[Agent]] = {
            s: build_population(self.population, fair[s]) for s in fair
        }
        self.trades_this_tick = 0
        self.ticks: dict[str, int] = {s: 0 for s in fair}
        # (order id, tick placed) for every agent order still working. Without
        # this, unfilled limit orders accumulate forever and the book fills up
        # with quotes nobody stands behind any more.
        self._working: dict[str, list[tuple[int, int]]] = {s: [] for s in fair}
        # Rolling record of price against fair value, one sample per tick. Fair
        # value lives only in memory, so this is the only place its past exists.
        self._drift: dict[str, float] = {s: 0.0 for s in fair}
        self.history: dict[str, deque[tuple[float, int, int]]] = {
            s: deque(maxlen=HISTORY) for s in fair
        }

    # -- setup --------------------------------------------------------------

    def ensure_accounts(self, session: Session) -> None:
        """Give every agent cash and inventory. Idempotent."""
        ex = Exchange(session, books=self.books)
        for symbol, agents in self.agents.items():
            for agent in agents:
                name = account_name(symbol, agent.name)
                try:
                    account = ex.get_account(name)
                except ExchangeError:
                    account = ex.open_account(name, AGENT_CASH)
                if account.available_cents < AGENT_CASH // 4:
                    account.cash_cents += AGENT_CASH
                pos = ex.position(account.id, symbol)
                if pos.available_quantity < AGENT_SHARES // 4:
                    pos.quantity += AGENT_SHARES
        session.commit()

    def cancel_orphans(self, session: Session) -> int:
        """Pull every agent order left over from a previous run.

        Postgres restores all open orders on startup -- correctly, for people.
        But agent orders belong to agent objects that no longer exist, so
        nothing would ever expire or requote them. They would sit at stale
        prices indefinitely, and when the near side of the book thinned out a
        market order would walk into them and print a fake spike.

        Human orders are untouched: those still belong to someone.
        """
        ex = Exchange(session, books=self.books)
        stale = session.exec(
            select(OrderRecord)
            .join(Account, Account.id == OrderRecord.account_id)
            .where(Account.name.startswith(f"{PREFIX}:"))
            .where(OrderRecord.status.in_([OrderStatus.OPEN, OrderStatus.PARTIAL]))
        ).all()
        for order in stale:
            try:
                ex.cancel_order(order.id)
            except ExchangeError:
                pass
        return len(stale)

    def set_population(self, session: Session, pop: Population) -> None:
        """Rebuild the agent roster. Existing resting orders stay on the book."""
        self.population = pop
        self.agents = {
            s: build_population(pop, self.fair[s]) for s in self.agents
        }
        self.ensure_accounts(session)

    # -- the tick -----------------------------------------------------------

    def observe(self, symbol: str) -> MarketState:
        book = self.books[symbol]
        return MarketState(
            symbol=symbol,
            best_bid=book.best_bid,
            best_ask=book.best_ask,
            last_price=self.last[symbol],
            recent=list(self.recent[symbol]),
            tick_prices=[p for _, p, _ in list(self.history[symbol])[-12:]],
        )

    def tick(self, session: Session, symbol: str) -> int:
        """One round of trading. Returns how many trades printed."""
        ex = Exchange(session, books=self.books)
        book = self.books[symbol]
        self.ticks[symbol] += 1
        self._expire(ex, symbol)
        state = self.observe(symbol)

        self._drift_fair(symbol)

        agents = self.agents[symbol]
        makers = [a for a in agents if isinstance(a, MarketMakerAgent)]

        # Makers requote FIRST, before anyone else trades. A market maker is
        # supposed to be continuously quoted; if it pulls its quotes and then
        # waits its turn in a shuffled queue, everyone drawn ahead of it trades
        # against a book with no maker liquidity in it at all. On a fresh start
        # the book is empty, and the first market order falls straight through.
        printed = 0
        for maker in makers:
            for oid in maker.resting:
                try:
                    ex.cancel_order(oid)
                except ExchangeError:
                    pass
            maker.resting = []
            # Most of a maker's inventory arrives passively -- other agents
            # hitting quotes it left sitting there -- so read the real number.
            maker.inventory = self._inventory(session, ex, symbol, maker.name)
            for intent in maker.act(state, book):
                printed += len(self._submit(ex, symbol, maker, intent))
            state = self.observe(symbol)

        others = [a for a in agents
                  if not isinstance(a, MarketMakerAgent) and random.random() < ACT_FRACTION]
        random.shuffle(others)

        for agent in others:
            if isinstance(agent, ValueTrader):
                intents = agent.act(state, book, fair=self.fair[symbol])
            else:
                intents = agent.act(state, book)

            for intent in intents:
                trades = self._submit(ex, symbol, agent, intent)
                printed += len(trades)
                for t in trades:
                    self.record_trade(symbol, t.price_cents)
                # Each order changes the book, so the next agent sees the result.
                state = self.observe(symbol)

        session.commit()
        self.trades_this_tick = printed
        self.history[symbol].append((time.time(), self.last[symbol], self.fair[symbol]))
        return printed

    def shock(self, session: Session, symbol: str, side: Side,
              quantity: int) -> ShockResult:
        """Drop a large market order in and see what the book does."""
        ex = Exchange(session, books=self.books)
        shocker = account_name(symbol, "shock")
        try:
            ex.get_account(shocker)
        except ExchangeError:
            ex.open_account(shocker, AGENT_CASH * 10)
            session.commit()
        pos = ex.position(ex.get_account(shocker).id, symbol)
        if pos.available_quantity < quantity:
            pos.quantity += quantity * 4
        account = ex.get_account(shocker)
        if account.available_cents < AGENT_CASH:
            account.cash_cents += AGENT_CASH * 10
        session.commit()

        book = self.books[symbol]
        if book.best_bid is not None and book.best_ask is not None:
            mid = (book.best_bid + book.best_ask) // 2
        else:
            mid = self.last[symbol]

        try:
            _, trades = ex.place_order(shocker, symbol, side, quantity, None)
        except ExchangeError:
            trades = []

        filled = sum(t.quantity for t in trades)
        notional = sum(t.price_cents * t.quantity for t in trades)
        result = ShockResult(
            side=side.value,
            requested=quantity,
            filled=filled,
            mid_before=mid,
            avg_fill=notional // filled if filled else mid,
            last_fill=trades[-1].price_cents if trades else mid,
            orders_hit=len(trades),
        )
        for t in trades:
            self.record_trade(symbol, t.price_cents)
        session.commit()
        return result

    # -- internals ----------------------------------------------------------

    def _submit(self, ex: Exchange, symbol: str, agent: Agent,
                intent: Intent) -> list:
        if intent.price is not None and intent.price <= 0:
            return []
        name = account_name(symbol, agent.name)
        try:
            record, trades = ex.place_order(
                name, symbol, intent.side, intent.quantity, intent.price
            )
        except ExchangeError:
            # Out of cash or out of shares. A real participant hits this too.
            return []

        if record.remaining > 0:
            if isinstance(agent, MarketMakerAgent):
                agent.resting.append(record.id)
            else:
                self._working[symbol].append((record.id, self.ticks[symbol]))

        signed = record.filled_quantity
        agent.inventory += signed if intent.side is Side.BUY else -signed
        return trades

    def _expire(self, ex: Exchange, symbol: str) -> None:
        """Pull agent orders that have sat unfilled too long."""
        now = self.ticks[symbol]
        keep: list[tuple[int, int]] = []
        for order_id, placed in self._working[symbol]:
            if now - placed < ORDER_TTL:
                keep.append((order_id, placed))
                continue
            try:
                ex.cancel_order(order_id)
            except ExchangeError:
                pass  # already filled or cancelled
        self._working[symbol] = keep

    def _inventory(self, session: Session, ex: Exchange, symbol: str,
                   agent_name: str) -> int:
        """What this agent is actually holding, relative to where it started."""
        try:
            account = ex.get_account(account_name(symbol, agent_name))
        except ExchangeError:
            return 0
        pos = session.exec(
            select(Position)
            .where(Position.account_id == account.id)
            .where(Position.symbol == symbol)
        ).first()
        return 0 if pos is None else pos.quantity - AGENT_SHARES

    def record_trade(self, symbol: str, price: int) -> None:
        self.last[symbol] = price
        window = self.recent[symbol]
        window.append(price)
        if len(window) > RECENT_WINDOW:
            del window[0]

    def _drift_fair(self, symbol: str) -> None:
        """Move fair value: smooth second to second, wandering over minutes.

        A pure random walk -- a fresh independent jump every tick -- made fair
        value jitter MORE than the price did, which is backwards. Underlying
        value changes slowly; prices are the noisy part. So the drift itself is
        persistent: each tick mostly continues the last one. The innovation is
        scaled by (1 - persistence) so the long-run wander matches the old walk
        while tick-to-tick moves come out several times smaller.
        """
        k = 1.0 - FAIR_PERSIST
        bias = self.sentiment * FAIR_VOL * 1.4 * k
        self._drift[symbol] = (FAIR_PERSIST * self._drift[symbol]
                               + random.gauss(bias, FAIR_VOL * k))
        self.fair[symbol] = max(100, int(self.fair[symbol] * math.exp(self._drift[symbol])))
