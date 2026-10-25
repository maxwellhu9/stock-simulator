"""Profit and loss, by the average-cost method.

Buying adds to the position at whatever it cost. Selling takes shares out at the
current average, and the difference between that average and the sale price is
realized -- it actually happened. Whatever is still held is unrealized: it is
only a gain or loss at today's price, and changes every time the price does.

Computed from the trade history rather than stored, so it can never drift out
of agreement with the trades it is derived from.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session, or_, select

from .models import TradeRecord


@dataclass
class Basis:
    quantity: int = 0
    cost_cents: int = 0      # total paid for the shares still held
    realized_cents: int = 0  # locked-in gain or loss from shares already sold

    @property
    def avg_cost(self) -> int | None:
        return round(self.cost_cents / self.quantity) if self.quantity else None


def cost_basis(session: Session, account_id: int) -> dict[str, Basis]:
    """Replay an account's trades in order and work out what it paid."""
    trades = session.exec(
        select(TradeRecord)
        .where(or_(TradeRecord.buyer_account_id == account_id,
                   TradeRecord.seller_account_id == account_id))
        .order_by(TradeRecord.id)
    ).all()

    out: dict[str, Basis] = {}
    for t in trades:
        b = out.setdefault(t.symbol, Basis())
        if t.buyer_account_id == t.seller_account_id:
            continue  # trading with yourself moves nothing
        if t.buyer_account_id == account_id:
            b.quantity += t.quantity
            b.cost_cents += t.price_cents * t.quantity
        else:
            if b.quantity <= 0:
                continue  # selling stock that predates this history
            q = min(t.quantity, b.quantity)
            avg = b.cost_cents / b.quantity
            b.realized_cents += round(q * (t.price_cents - avg))
            b.cost_cents -= round(q * avg)
            b.quantity -= q
    return out
