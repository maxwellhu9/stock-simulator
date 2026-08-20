"""Request and response shapes for the HTTP API.

The API speaks dollars as strings ("99.50"); everything inside speaks integer
cents. Conversion happens here at the boundary and nowhere else, so there is
exactly one place where a money bug could enter.

Strings rather than JSON numbers, because JSON numbers are IEEE floats -- the
very thing app.money exists to keep away from balances. A client that sends
99.50 as a float has already lost precision before the request arrives.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from .money import format_cents, to_cents
from .models import OrderRecord, OrderStatus, Position, TradeRecord
from .orderbook import Side


def _money_field(v: str | int | None) -> int | None:
    if v is None:
        return None
    try:
        return to_cents(v)
    except (TypeError, ValueError) as exc:
        raise ValueError(str(exc)) from exc


# -- requests ---------------------------------------------------------------


class CreateAccountRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    initial_cash: str = "0.00"

    @field_validator("initial_cash")
    @classmethod
    def _check_cash(cls, v: str) -> str:
        if to_cents(v) < 0:
            raise ValueError("initial cash cannot be negative")
        return v

    @property
    def initial_cash_cents(self) -> int:
        return to_cents(self.initial_cash)


class DepositRequest(BaseModel):
    amount: str

    @field_validator("amount")
    @classmethod
    def _positive(cls, v: str) -> str:
        if to_cents(v) <= 0:
            raise ValueError("deposit must be positive")
        return v

    @property
    def amount_cents(self) -> int:
        return to_cents(self.amount)


class PlaceOrderRequest(BaseModel):
    account: str
    symbol: str = Field(min_length=1, max_length=16)
    side: Side
    quantity: int = Field(gt=0)
    # Omit for a market order: "any price, right now."
    limit_price: str | None = None

    @field_validator("limit_price")
    @classmethod
    def _check_price(cls, v: str | None) -> str | None:
        if v is not None and to_cents(v) <= 0:
            raise ValueError("limit price must be positive")
        return v

    @property
    def limit_price_cents(self) -> int | None:
        return _money_field(self.limit_price)


# -- responses --------------------------------------------------------------


class Money(BaseModel):
    """Every amount goes out both ways: exact cents, plus something displayable."""

    cents: int
    display: str

    @classmethod
    def of(cls, cents: int) -> "Money":
        return cls(cents=cents, display=format_cents(cents))


class PositionOut(BaseModel):
    symbol: str
    quantity: int
    reserved: int
    available: int

    @classmethod
    def of(cls, p: Position) -> "PositionOut":
        return cls(symbol=p.symbol, quantity=p.quantity,
                   reserved=p.reserved_quantity, available=p.available_quantity)


class PortfolioOut(BaseModel):
    name: str
    cash: Money
    reserved: Money
    available: Money
    positions: list[PositionOut]


class OrderOut(BaseModel):
    id: int
    account_id: int
    symbol: str
    side: Side
    quantity: int
    filled_quantity: int
    remaining: int
    limit_price: Money | None
    status: OrderStatus
    created_at: datetime

    @classmethod
    def of(cls, o: OrderRecord) -> "OrderOut":
        return cls(
            id=o.id, account_id=o.account_id, symbol=o.symbol, side=o.side,
            quantity=o.quantity, filled_quantity=o.filled_quantity,
            remaining=o.remaining,
            limit_price=None if o.limit_price_cents is None
            else Money.of(o.limit_price_cents),
            status=o.status, created_at=o.created_at,
        )


class TradeOut(BaseModel):
    id: int
    symbol: str
    price: Money
    quantity: int
    notional: Money
    buy_order_id: int
    sell_order_id: int
    created_at: datetime

    @classmethod
    def of(cls, t: TradeRecord) -> "TradeOut":
        return cls(
            id=t.id, symbol=t.symbol, price=Money.of(t.price_cents),
            quantity=t.quantity, notional=Money.of(t.notional_cents),
            buy_order_id=t.buy_order_id, sell_order_id=t.sell_order_id,
            created_at=t.created_at,
        )


class PlaceOrderResponse(BaseModel):
    order: OrderOut
    trades: list[TradeOut]


class Level(BaseModel):
    price: Money
    quantity: int


class BookOut(BaseModel):
    symbol: str
    bids: list[Level]
    asks: list[Level]
    best_bid: Money | None
    best_ask: Money | None
    spread: Money | None
