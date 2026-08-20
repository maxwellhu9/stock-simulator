"""Tests for the money rules. Each pins down something that must never break."""

import pytest

from app.exchange import InsufficientFunds, InsufficientShares
from app.orderbook import Side

M = 100_00  # $100.00 in cents, for readability


def test_new_account_has_its_cash(ex):
    a = ex.open_account("alice", 50_000_00)
    assert a.cash_cents == 50_000_00
    assert a.available_cents == 50_000_00


def test_limit_buy_reserves_cash_before_it_fills(ex):
    ex.open_account("alice", 50_000_00)
    order, trades = ex.place_order("alice", "ACME", Side.BUY, 100, M)

    assert trades == []
    p = ex.portfolio("alice")
    assert p["cash_cents"] == 50_000_00      # nothing spent yet
    assert p["reserved_cents"] == 10_000_00  # but 100 x $100 is committed
    assert p["available_cents"] == 40_000_00


def test_cannot_spend_the_same_dollars_twice(ex):
    """The whole point of reserving. Two orders, each affordable alone."""
    ex.open_account("alice", 15_000_00)
    ex.place_order("alice", "ACME", Side.BUY, 100, M)   # commits $10,000
    with pytest.raises(InsufficientFunds):
        ex.place_order("alice", "ACME", Side.BUY, 100, M)  # only $5,000 left


def test_cannot_sell_shares_you_do_not_own(ex):
    ex.open_account("alice", 50_000_00)
    with pytest.raises(InsufficientShares):
        ex.place_order("alice", "ACME", Side.SELL, 10, M)


def test_a_fill_moves_cash_and_shares(ex):
    ex.open_account("alice", 50_000_00)
    ex.open_account("bob", 50_000_00)
    # Seed bob with shares so he has something to sell.
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    ex.session.commit()

    ex.place_order("bob", "ACME", Side.SELL, 100, M)
    order, trades = ex.place_order("alice", "ACME", Side.BUY, 100, M)

    assert len(trades) == 1
    assert trades[0].price_cents == M
    assert trades[0].quantity == 100

    alice, bob = ex.portfolio("alice"), ex.portfolio("bob")
    assert alice["cash_cents"] == 40_000_00
    assert alice["positions"] == [{"symbol": "ACME", "quantity": 100, "reserved": 0}]
    assert bob["cash_cents"] == 60_000_00
    assert bob["positions"] == [{"symbol": "ACME", "quantity": 400, "reserved": 0}]


def test_money_is_conserved(ex):
    """Nothing is created or destroyed -- only moved."""
    ex.open_account("alice", 50_000_00)
    ex.open_account("bob", 50_000_00)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    ex.session.commit()

    before = (ex.portfolio("alice")["cash_cents"]
              + ex.portfolio("bob")["cash_cents"])

    ex.place_order("bob", "ACME", Side.SELL, 100, 99_00)
    ex.place_order("alice", "ACME", Side.BUY, 100, 101_00)

    after = (ex.portfolio("alice")["cash_cents"]
             + ex.portfolio("bob")["cash_cents"])
    assert before == after == 100_000_00

    shares = (ex.portfolio("alice")["positions"][0]["quantity"]
              + ex.portfolio("bob")["positions"][0]["quantity"])
    assert shares == 500


def test_price_improvement_refunds_the_difference(ex):
    """Alice bids $101 but fills at $99. The extra $2/share returns to her."""
    ex.open_account("alice", 50_000_00)
    ex.open_account("bob", 0)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    ex.session.commit()

    ex.place_order("bob", "ACME", Side.SELL, 100, 99_00)
    ex.place_order("alice", "ACME", Side.BUY, 100, 101_00)

    alice = ex.portfolio("alice")
    assert alice["cash_cents"] == 50_000_00 - 9_900_00  # paid 99, not 101
    assert alice["reserved_cents"] == 0                 # nothing still held back
    assert alice["available_cents"] == 40_100_00


def test_cancelling_releases_the_reservation(ex):
    ex.open_account("alice", 50_000_00)
    order, _ = ex.place_order("alice", "ACME", Side.BUY, 100, M)
    assert ex.portfolio("alice")["available_cents"] == 40_000_00

    ex.cancel_order(order.id)
    assert ex.portfolio("alice")["available_cents"] == 50_000_00


def test_market_buy_rejected_when_too_expensive(ex):
    ex.open_account("alice", 5_000_00)
    ex.open_account("bob", 0)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    ex.session.commit()
    ex.place_order("bob", "ACME", Side.SELL, 100, M)  # $10,000 of stock

    with pytest.raises(InsufficientFunds):
        ex.place_order("alice", "ACME", Side.BUY, 100, None)

    assert ex.portfolio("alice")["cash_cents"] == 5_000_00  # untouched


def test_sold_shares_are_reserved_not_double_sold(ex):
    ex.open_account("bob", 0)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 100
    ex.session.commit()

    ex.place_order("bob", "ACME", Side.SELL, 100, M)
    with pytest.raises(InsufficientShares):
        ex.place_order("bob", "ACME", Side.SELL, 100, M)


# -- surviving a restart ---------------------------------------------------


def test_book_is_empty_after_a_restart_until_reloaded(ex, session):
    """The gap this guards against: open orders stranded in memory-less limbo."""
    from app.exchange import Exchange

    ex.open_account("alice", 50_000_00)
    ex.place_order("alice", "ACME", Side.BUY, 100, M)
    assert ex.book("ACME").best_bid == M

    restarted = Exchange(session)          # fresh process, empty books
    assert restarted.book("ACME").best_bid is None

    assert restarted.load_books() == 1
    assert restarted.book("ACME").best_bid == M


def test_restored_orders_still_trade(ex, session):
    from app.exchange import Exchange

    ex.open_account("alice", 50_000_00)
    ex.open_account("bob", 0)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    session.commit()
    ex.place_order("alice", "ACME", Side.BUY, 100, M)

    restarted = Exchange(session)
    restarted.load_books()

    _, trades = restarted.place_order("bob", "ACME", Side.SELL, 100, M)
    assert len(trades) == 1
    assert trades[0].quantity == 100
    assert restarted.portfolio("alice")["positions"][0]["quantity"] == 100


def test_restore_preserves_time_priority(ex, session):
    from app.exchange import Exchange

    ex.open_account("alice", 50_000_00)
    ex.open_account("carol", 50_000_00)
    ex.open_account("bob", 0)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    session.commit()

    ex.place_order("alice", "ACME", Side.BUY, 100, M)   # first in line
    ex.place_order("carol", "ACME", Side.BUY, 100, M)   # second

    restarted = Exchange(session)
    restarted.load_books()

    _, trades = restarted.place_order("bob", "ACME", Side.SELL, 100, M)
    assert len(trades) == 1
    # Alice was first before the restart, so she must be first after it.
    assert trades[0].buyer_account_id == ex.get_account("alice").id


def test_restore_keeps_only_the_unfilled_remainder(ex, session):
    from app.exchange import Exchange

    ex.open_account("alice", 50_000_00)
    ex.open_account("bob", 0)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    session.commit()

    ex.place_order("alice", "ACME", Side.BUY, 100, M)
    ex.place_order("bob", "ACME", Side.SELL, 30, M)     # alice has 70 left

    restarted = Exchange(session)
    restarted.load_books()
    assert restarted.book("ACME").depth(Side.BUY) == [(M, 70)]


def test_market_orders_are_never_restored(ex, session):
    """They cannot rest, so there is nothing to bring back."""
    from app.exchange import Exchange

    ex.open_account("alice", 50_000_00)
    ex.open_account("bob", 0)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    session.commit()
    ex.place_order("bob", "ACME", Side.SELL, 10, M)
    ex.place_order("alice", "ACME", Side.BUY, 100, None)  # 90 unfilled, expired

    restarted = Exchange(session)
    assert restarted.load_books() == 0
    assert restarted.book("ACME").best_bid is None


def test_balances_exceed_a_32_bit_integer(ex):
    """Money columns must be BIGINT. In cents, INTEGER caps out near $21.4M."""
    big = 100_000_000_00  # $100,000,000 -> 10,000,000,000 cents
    ex.open_account("whale", big)
    ex.session.commit()
    assert ex.portfolio("whale")["cash_cents"] == big
