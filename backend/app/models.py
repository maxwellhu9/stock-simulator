"""Database tables. Every monetary amount is integer cents (see app.money).

The important idea in here is the distinction between what you HAVE and what you
can still SPEND.

When you place an order to buy 200 shares at $99.50, that $19,900 is not gone --
the trade has not happened yet, and it might never happen. But it is not
available either: if you could place a second order with the same dollars, you
could commit to buying more than you can pay for. So the money is *reserved*.

  available cash  = cash_cents - reserved_cents
  sellable shares = quantity - reserved_quantity

Every cents column is BIGINT, never INTEGER. A 32-bit integer stops at
2,147,483,647, which in cents is about $21.4 million -- a ceiling a financial
system reaches almost immediately. SQLModel maps a plain Python int to INTEGER,
so the wider type has to be asked for explicitly.

Every open order holds a reservation. Filling or cancelling it releases one.
This is the single rule that keeps the exchange solvent.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import BigInteger
from sqlmodel import Field, SQLModel, UniqueConstraint

from .orderbook import Side  # reuse the same BUY/SELL the engine uses


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class OrderStatus(str, Enum):
    OPEN = "open"                 # resting on the book, nothing filled
    PARTIAL = "partially_filled"  # some filled, remainder still resting
    FILLED = "filled"
    CANCELLED = "cancelled"
    EXPIRED = "expired"           # a market order that ran out of book


class Account(SQLModel, table=True):
    __tablename__ = "account"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    cash_cents: int = Field(default=0, sa_type=BigInteger)
    reserved_cents: int = Field(default=0, sa_type=BigInteger)
    created_at: datetime = Field(default_factory=_utcnow)

    @property
    def available_cents(self) -> int:
        """What can still be committed to a new buy order."""
        return self.cash_cents - self.reserved_cents


class Position(SQLModel, table=True):
    """How many shares of one symbol an account holds."""

    __tablename__ = "position"
    __table_args__ = (UniqueConstraint("account_id", "symbol"),)

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="account.id", index=True)
    symbol: str = Field(index=True)
    quantity: int = Field(default=0)
    reserved_quantity: int = Field(default=0)

    @property
    def available_quantity(self) -> int:
        """What can still be committed to a new sell order."""
        return self.quantity - self.reserved_quantity


class OrderRecord(SQLModel, table=True):
    """The durable record of an order.

    The in-memory book holds only orders that are still working. This table
    holds every order ever placed, including filled and cancelled ones, because
    a brokerage has to be able to show you your history.
    """

    __tablename__ = "order_record"

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="account.id", index=True)
    symbol: str = Field(index=True)
    side: Side
    quantity: int
    filled_quantity: int = Field(default=0)
    # None means a market order: "any price, right now."
    limit_price_cents: int | None = Field(default=None, sa_type=BigInteger)
    # What this order still ties up. Released as it fills or is cancelled.
    reserved_cents: int = Field(default=0, sa_type=BigInteger)
    reserved_quantity: int = Field(default=0)
    status: OrderStatus = Field(default=OrderStatus.OPEN, index=True)
    created_at: datetime = Field(default_factory=_utcnow)

    @property
    def is_market(self) -> bool:
        return self.limit_price_cents is None

    @property
    def remaining(self) -> int:
        return self.quantity - self.filled_quantity


class TradeRecord(SQLModel, table=True):
    """One completed match. Immutable once written -- this is the audit trail."""

    __tablename__ = "trade_record"

    id: int | None = Field(default=None, primary_key=True)
    symbol: str = Field(index=True)
    price_cents: int = Field(sa_type=BigInteger)
    quantity: int
    buy_order_id: int = Field(foreign_key="order_record.id", index=True)
    sell_order_id: int = Field(foreign_key="order_record.id", index=True)
    buyer_account_id: int = Field(foreign_key="account.id", index=True)
    seller_account_id: int = Field(foreign_key="account.id", index=True)
    created_at: datetime = Field(default_factory=_utcnow)

    @property
    def notional_cents(self) -> int:
        """Total money that changed hands."""
        return self.price_cents * self.quantity
