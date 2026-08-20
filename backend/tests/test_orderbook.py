"""Tests for the matching engine. All prices are integer cents. Each one pins down a rule that must not drift."""

import pytest

from app.orderbook import OrderBook, Side


@pytest.fixture
def book() -> OrderBook:
    return OrderBook("SPY")


def test_resting_order_does_not_trade(book):
    """An order with nothing to match against just sits on the book."""
    order, trades = book.submit("alice", Side.BUY, 100, price=5000)
    assert trades == []
    assert order.remaining == 100
    assert book.best_bid == 5000
    assert book.best_ask is None


def test_simple_cross(book):
    book.submit("alice", Side.SELL, 100, price=5000)
    order, trades = book.submit("bob", Side.BUY, 100, price=5000)

    assert len(trades) == 1
    assert trades[0].price == 5000
    assert trades[0].quantity == 100
    assert trades[0].buyer_id == "bob"
    assert trades[0].seller_id == "alice"
    assert order.remaining == 0
    assert book.best_bid is None and book.best_ask is None


def test_price_improvement_goes_to_the_aggressor(book):
    """Bob will pay up to 55, but Alice is already asking 50. Bob pays 50."""
    book.submit("alice", Side.SELL, 100, price=5000)
    _, trades = book.submit("bob", Side.BUY, 100, price=5500)

    assert trades[0].price == 5000
    assert trades[0].aggressor is Side.BUY


def test_time_priority_within_a_price_level(book):
    """Same price, so the earlier order must fill first."""
    first, _ = book.submit("alice", Side.SELL, 50, price=5000)
    second, _ = book.submit("carol", Side.SELL, 50, price=5000)

    _, trades = book.submit("bob", Side.BUY, 50, price=5000)

    assert len(trades) == 1
    assert trades[0].seller_id == "alice"
    assert first.remaining == 0
    assert second.remaining == 50


def test_better_price_jumps_the_queue(book):
    """Carol arrived later but is cheaper, so she trades first."""
    book.submit("alice", Side.SELL, 50, price=5100)
    book.submit("carol", Side.SELL, 50, price=5000)

    _, trades = book.submit("bob", Side.BUY, 50, price=5100)

    assert trades[0].seller_id == "carol"
    assert trades[0].price == 5000


def test_partial_fill_rests_the_remainder(book):
    book.submit("alice", Side.SELL, 30, price=5000)
    order, trades = book.submit("bob", Side.BUY, 100, price=5000)

    assert trades[0].quantity == 30
    assert order.remaining == 70
    assert book.best_bid == 5000  # the leftover 70 is now the best bid


def test_market_order_sweeps_multiple_levels(book):
    book.submit("alice", Side.SELL, 50, price=5000)
    book.submit("carol", Side.SELL, 50, price=5100)
    book.submit("dave", Side.SELL, 50, price=5200)

    order, trades = book.submit("bob", Side.BUY, 120, price=None)

    assert [t.price for t in trades] == [5000, 5100, 5200]
    assert [t.quantity for t in trades] == [50, 50, 20]
    assert order.remaining == 0
    assert book.best_ask == 5200  # 30 left at the top level


def test_unfilled_market_order_is_abandoned_not_rested(book):
    """A market order has no price, so there is nowhere for it to rest."""
    book.submit("alice", Side.SELL, 10, price=5000)
    order, trades = book.submit("bob", Side.BUY, 100, price=None)

    assert trades[0].quantity == 10
    assert order.remaining == 90
    assert book.best_bid is None  # nothing rested


def test_cancel_removes_from_book(book):
    order, _ = book.submit("alice", Side.BUY, 100, price=5000)
    assert book.cancel(order.id) is True
    assert book.best_bid is None
    assert book.cancel(order.id) is False  # cannot cancel twice


def test_cancelled_order_cannot_be_hit(book):
    order, _ = book.submit("alice", Side.SELL, 100, price=5000)
    book.cancel(order.id)

    _, trades = book.submit("bob", Side.BUY, 100, price=5000)
    assert trades == []


def test_depth_aggregates_quantity_per_level(book):
    book.submit("alice", Side.BUY, 10, price=4900)
    book.submit("carol", Side.BUY, 25, price=4900)
    book.submit("dave", Side.BUY, 5, price=4800)

    assert book.depth(Side.BUY) == [(4900, 35), (4800, 5)]


def test_spread(book):
    book.submit("alice", Side.BUY, 10, price=4900)
    book.submit("carol", Side.SELL, 10, price=5100)
    assert book.spread == pytest.approx(200)


def test_rejects_nonsense_orders(book):
    with pytest.raises(ValueError):
        book.submit("alice", Side.BUY, 0, price=5000)
    with pytest.raises(ValueError):
        book.submit("alice", Side.BUY, 10, price=-100)
