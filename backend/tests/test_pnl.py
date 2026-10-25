"""Average-cost P&L. Numbers chosen so every answer can be checked by hand."""

from app.orderbook import Side
from app.pnl import cost_basis


def _seed(ex, name, shares):
    ex.open_account(name, 1_000_000_00)
    ex.position(ex.get_account(name).id, "ACME").quantity = shares
    ex.session.commit()


def test_average_cost_and_realized_gain(ex):
    _seed(ex, "alice", 0)
    _seed(ex, "bob", 1_000)
    _seed(ex, "carol", 0)

    # Alice buys 100 at $100, then 100 at $110 -> average cost $105.
    ex.place_order("bob", "ACME", Side.SELL, 100, 100_00)
    ex.place_order("alice", "ACME", Side.BUY, 100, 100_00)
    ex.place_order("bob", "ACME", Side.SELL, 100, 110_00)
    ex.place_order("alice", "ACME", Side.BUY, 100, 110_00)

    b = cost_basis(ex.session, ex.get_account("alice").id)["ACME"]
    assert b.quantity == 200
    assert b.avg_cost == 105_00
    assert b.realized_cents == 0

    # She sells 50 at $120: 50 x ($120 - $105) = $750 realized.
    ex.place_order("carol", "ACME", Side.BUY, 50, 120_00)
    ex.place_order("alice", "ACME", Side.SELL, 50, 120_00)

    b = cost_basis(ex.session, ex.get_account("alice").id)["ACME"]
    assert b.quantity == 150
    assert b.avg_cost == 105_00          # selling never changes the average
    assert b.realized_cents == 750_00
    assert b.cost_cents == 150 * 105_00


def test_a_loss_is_negative(ex):
    _seed(ex, "alice", 0)
    _seed(ex, "bob", 1_000)
    _seed(ex, "carol", 0)

    ex.place_order("bob", "ACME", Side.SELL, 10, 100_00)
    ex.place_order("alice", "ACME", Side.BUY, 10, 100_00)
    ex.place_order("carol", "ACME", Side.BUY, 10, 90_00)
    ex.place_order("alice", "ACME", Side.SELL, 10, 90_00)

    b = cost_basis(ex.session, ex.get_account("alice").id)["ACME"]
    assert b.quantity == 0
    assert b.avg_cost is None
    assert b.realized_cents == -100_00
