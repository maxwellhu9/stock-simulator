"""A limit order book with price-time priority.

This is the heart of the exchange. Everything else -- accounts, the API, the
frontend -- is bookkeeping around this file.

The rule the whole thing implements is **price-time priority**:

  1. Better prices go first. A buyer offering 101 is served before one offering
     100, because they are willing to pay more.
  2. Among equal prices, whoever arrived first goes first. This is what makes an
     exchange fair rather than arbitrary, and it is why standing in line early is
     worth something.

Trades execute at the RESTING order's price, not the incoming one. If someone is
already offering to sell at 100 and you arrive willing to pay up to 105, you pay
100 -- the price improvement belongs to you as the one crossing the spread, and
the resting order gets exactly what it asked for.
"""

from __future__ import annotations

import bisect
import itertools
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Iterator


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"

    @property
    def opposite(self) -> "Side":
        return Side.SELL if self is Side.BUY else Side.BUY


@dataclass
class Order:
    """A single instruction to buy or sell.

    `price` is None for a market order, which means "any price, right now."
    `remaining` shrinks as the order is filled; an order is done when it hits 0.
    """

    id: int
    account_id: str
    side: Side
    quantity: int
    price: int | None = None
    remaining: int = field(init=False)

    def __post_init__(self) -> None:
        if self.quantity <= 0:
            raise ValueError("quantity must be positive")
        if self.price is not None:
            if not isinstance(self.price, int):
                raise TypeError("price must be integer cents, not a float")
            if self.price <= 0:
                raise ValueError("price must be positive")
        self.remaining = self.quantity

    @property
    def is_market(self) -> bool:
        return self.price is None

    @property
    def filled(self) -> int:
        return self.quantity - self.remaining


@dataclass(frozen=True)
class Trade:
    """A completed match between two orders."""

    price: int
    quantity: int
    buy_order_id: int
    sell_order_id: int
    buyer_id: str
    seller_id: str
    aggressor: Side  # which side crossed the spread to make this happen


class OrderBook:
    """One book for one symbol.

    Price levels are held in dicts keyed by price, each holding a FIFO queue of
    orders at that price. A sorted list of active prices sits alongside so the
    best bid and ask are always O(1) to read -- which matters because they are
    read constantly and written comparatively rarely.
    """

    def __init__(self, symbol: str) -> None:
        self.symbol = symbol
        self._bids: dict[int, deque[Order]] = {}
        self._asks: dict[int, deque[Order]] = {}
        # Both kept ascending. Best bid is the LAST element (highest price a
        # buyer will pay); best ask is the FIRST (lowest a seller will accept).
        self._bid_prices: list[int] = []
        self._ask_prices: list[int] = []
        self._by_id: dict[int, Order] = {}
        self._ids = itertools.count(1)

    # -- reading the book ---------------------------------------------------

    @property
    def best_bid(self) -> int | None:
        return self._bid_prices[-1] if self._bid_prices else None

    @property
    def best_ask(self) -> int | None:
        return self._ask_prices[0] if self._ask_prices else None

    @property
    def spread(self) -> int | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        return self.best_ask - self.best_bid

    def depth(self, side: Side, levels: int = 5) -> list[tuple[int, int]]:
        """Top N price levels as (price, total quantity), best first."""
        if side is Side.BUY:
            prices = list(reversed(self._bid_prices))[:levels]
            book = self._bids
        else:
            prices = self._ask_prices[:levels]
            book = self._asks
        return [(p, sum(o.remaining for o in book[p])) for p in prices]

    def get(self, order_id: int) -> Order | None:
        return self._by_id.get(order_id)

    def cost_to_fill(self, side: Side, quantity: int) -> tuple[int, int]:
        """What a market order would cost, without placing it.

        Returns (total cents, quantity actually fillable). The second number can
        be less than requested when the book is too thin -- a market order can
        only trade against orders that exist.

        A brokerage needs this before accepting a market buy: it has to know the
        customer can pay before it lets the order touch the book, and a market
        order has no limit price to reserve against.
        """
        book = self._asks if side is Side.BUY else self._bids
        prices = self._ask_prices if side is Side.BUY else list(reversed(self._bid_prices))
        prices = self._ask_prices if side is Side.BUY else prices

        total = 0
        left = quantity
        for price in prices:
            if left <= 0:
                break
            available = sum(o.remaining for o in book[price])
            take = min(left, available)
            total += take * price
            left -= take
        return total, quantity - left

    # -- submitting and cancelling -----------------------------------------

    def submit(self, account_id: str, side: Side, quantity: int,
               price: int | None = None,
               order_id: int | None = None) -> tuple[Order, list[Trade]]:
        """Place an order, match what can be matched, rest whatever is left.

        `price is in integer cents (see app.money); None means a market order.
        `order_id` lets the caller supply an id from elsewhere -- once a database
        sits behind this, order ids come from there so the book and the stored
        record refer to the same order by the same number.

        Returns the order (so the caller can see how much filled) and the trades
        it generated.
        """
        if order_id is None:
            order_id = next(self._ids)
        elif order_id in self._by_id:
            raise ValueError(f"duplicate order id {order_id}")
        order = Order(id=order_id, account_id=account_id,
                      side=side, quantity=quantity, price=price)
        self._by_id[order.id] = order

        trades = list(self._match(order))

        # A market order that could not be fully filled does NOT rest on the
        # book -- "any price right now" has no price to rest at. The unfilled
        # remainder is simply abandoned.
        if order.remaining > 0 and not order.is_market:
            self._rest(order)

        return order, trades

    def restore(self, order_id: int, account_id: str, side: Side,
                quantity: int, price: int, remaining: int) -> Order:
        """Put a previously-resting order back on the book WITHOUT matching it.

        Used to rebuild the book from storage after a restart. Matching would be
        wrong here: these orders already coexisted without crossing, so running
        them through submit() would invent trades that never happened.

        Callers must restore in original arrival order to preserve time priority
        -- whoever was first in line before the restart must be first after it.
        """
        if price is None:
            raise ValueError("market orders never rest, so they cannot be restored")
        if not 0 < remaining <= quantity:
            raise ValueError(f"bad remaining {remaining} for quantity {quantity}")

        order = Order(id=order_id, account_id=account_id, side=side,
                      quantity=quantity, price=price)
        order.remaining = remaining
        self._by_id[order_id] = order
        self._rest(order)
        return order

    def cancel(self, order_id: int) -> bool:
        """Pull a resting order off the book. Returns False if it was not there."""
        order = self._by_id.get(order_id)
        if order is None or order.remaining == 0 or order.price is None:
            return False

        book = self._bids if order.side is Side.BUY else self._asks
        prices = self._bid_prices if order.side is Side.BUY else self._ask_prices
        queue = book.get(order.price)
        if queue is None or order not in queue:
            return False

        queue.remove(order)
        if not queue:
            del book[order.price]
            prices.remove(order.price)
        order.remaining = 0
        return True

    # -- internals ----------------------------------------------------------

    def _crosses(self, incoming: Order, resting_price: int) -> bool:
        """Would these two orders agree on a price?"""
        if incoming.is_market:
            return True
        if incoming.side is Side.BUY:
            return incoming.price >= resting_price
        return incoming.price <= resting_price

    def _match(self, incoming: Order) -> Iterator[Trade]:
        """Walk the opposite side of the book, best price first, filling as we go."""
        book = self._asks if incoming.side is Side.BUY else self._bids
        prices = self._ask_prices if incoming.side is Side.BUY else self._bid_prices

        while incoming.remaining > 0 and prices:
            # Best price on the other side: lowest ask, or highest bid.
            level_price = prices[0] if incoming.side is Side.BUY else prices[-1]
            if not self._crosses(incoming, level_price):
                break

            queue = book[level_price]
            while queue and incoming.remaining > 0:
                resting = queue[0]
                qty = min(incoming.remaining, resting.remaining)

                incoming.remaining -= qty
                resting.remaining -= qty

                buy, sell = ((incoming, resting) if incoming.side is Side.BUY
                             else (resting, incoming))
                yield Trade(
                    price=level_price,       # the resting order's price
                    quantity=qty,
                    buy_order_id=buy.id, sell_order_id=sell.id,
                    buyer_id=buy.account_id, seller_id=sell.account_id,
                    aggressor=incoming.side,
                )

                if resting.remaining == 0:
                    queue.popleft()

            if not queue:
                del book[level_price]
                prices.remove(level_price)

    def _rest(self, order: Order) -> None:
        """Add an unfilled remainder to the book, joining the back of its queue."""
        book = self._bids if order.side is Side.BUY else self._asks
        prices = self._bid_prices if order.side is Side.BUY else self._ask_prices

        if order.price not in book:
            book[order.price] = deque()
            bisect.insort(prices, order.price)
        book[order.price].append(order)
