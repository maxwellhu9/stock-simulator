"""The exchange service: the order book plus real accounts and real money.

The matching engine knows nothing about money -- hand it two orders and it will
happily match them whether or not anyone can pay. This layer is what makes the
exchange solvent. Every order passes three gates:

  1. CHECK    -- can this account actually afford it?
  2. RESERVE  -- set the money or shares aside so it cannot be spent twice.
  3. SETTLE   -- on each fill, move cash and shares and release the reservation.

The invariant worth stating out loud, because it is the thing that must never
break: cash and shares are only ever moved BETWEEN accounts. The exchange never
creates or destroys either one.
"""

from __future__ import annotations

from sqlmodel import Session, select

from .models import Account, OrderRecord, OrderStatus, Position, TradeRecord
from .money import dollars
from .orderbook import OrderBook, Side, Trade


class ExchangeError(Exception):
    """Base class for anything the caller did wrong."""


class UnknownAccount(ExchangeError):
    pass


class InsufficientFunds(ExchangeError):
    pass


class InsufficientShares(ExchangeError):
    pass


class Exchange:
    """One exchange, holding one order book per symbol."""

    def __init__(self, session: Session,
                 books: dict[str, OrderBook] | None = None) -> None:
        """
        `session` is per-request: it opens, does work, commits, and closes.

        `books` is NOT. The order book is long-lived process state, shared by
        every request -- if each request built its own, every resting order
        would vanish the moment that request finished. Passing a shared dict in
        lets the web layer own that lifetime while tests still get a fresh one
        per case by leaving it out.
        """
        self.session = session
        self._books: dict[str, OrderBook] = {} if books is None else books

    def book(self, symbol: str) -> OrderBook:
        if symbol not in self._books:
            self._books[symbol] = OrderBook(symbol)
        return self._books[symbol]

    def load_books(self) -> int:
        """Rebuild every in-memory book from the orders still open in the database.

        The book is memory; the database is truth. Without this, a restart leaves
        resting orders stranded -- still marked open, still holding a customer's
        money reserved, but invisible to matching. The money would be locked with
        no way to trade it or get it back.

        Orders are replayed in id order, which is arrival order, so whoever was
        first in the queue before the restart is first after it too.
        """
        open_orders = self.session.exec(
            select(OrderRecord)
            .where(OrderRecord.status.in_([OrderStatus.OPEN, OrderStatus.PARTIAL]))
            .where(OrderRecord.limit_price_cents.is_not(None))
            .order_by(OrderRecord.id)
        ).all()

        for rec in open_orders:
            if rec.remaining <= 0:
                continue
            self.book(rec.symbol).restore(
                order_id=rec.id, account_id=str(rec.account_id), side=rec.side,
                quantity=rec.quantity, price=rec.limit_price_cents,
                remaining=rec.remaining,
            )
        return len(open_orders)

    # -- accounts -----------------------------------------------------------

    def open_account(self, name: str, cash_cents: int = 0) -> Account:
        account = Account(name=name, cash_cents=cash_cents)
        self.session.add(account)
        self.session.commit()
        self.session.refresh(account)
        return account

    def get_account(self, name: str) -> Account:
        account = self.session.exec(
            select(Account).where(Account.name == name)
        ).first()
        if account is None:
            raise UnknownAccount(f"no account named {name!r}")
        return account

    def position(self, account_id: int, symbol: str) -> Position:
        """Fetch this account's holding in a symbol, creating an empty one if needed."""
        pos = self.session.exec(
            select(Position)
            .where(Position.account_id == account_id)
            .where(Position.symbol == symbol)
        ).first()
        if pos is None:
            pos = Position(account_id=account_id, symbol=symbol)
            self.session.add(pos)
            self.session.flush()
        return pos

    # -- placing orders -----------------------------------------------------

    def place_order(self, account_name: str, symbol: str, side: Side,
                    quantity: int, limit_price_cents: int | None = None
                    ) -> tuple[OrderRecord, list[TradeRecord]]:
        """Check, reserve, match, settle. All or nothing."""
        if quantity <= 0:
            raise ExchangeError("quantity must be positive")

        account = self.get_account(account_name)
        book = self.book(symbol)
        pos = self.position(account.id, symbol)

        reserve_cents, reserve_qty = self._check_and_reserve(
            account, pos, book, side, quantity, limit_price_cents
        )

        record = OrderRecord(
            account_id=account.id, symbol=symbol, side=side, quantity=quantity,
            limit_price_cents=limit_price_cents,
            reserved_cents=reserve_cents, reserved_quantity=reserve_qty,
        )
        self.session.add(record)
        self.session.flush()  # assign the id before the book sees the order

        _, trades = book.submit(
            account_id=str(account.id), side=side, quantity=quantity,
            price=limit_price_cents, order_id=record.id,
        )

        trade_records = [self._settle(symbol, t) for t in trades]

        self._finalize(record, book)
        self.session.commit()
        self.session.refresh(record)
        return record, trade_records

    def _check_and_reserve(self, account: Account, pos: Position, book: OrderBook,
                           side: Side, quantity: int,
                           limit_price_cents: int | None) -> tuple[int, int]:
        """Gate 1 and 2: refuse what cannot be paid for, then set it aside."""
        if side is Side.SELL:
            # You cannot sell shares you do not have. (No short selling here --
            # that would need a borrow, margin, and a whole risk model.)
            if pos.available_quantity < quantity:
                raise InsufficientShares(
                    f"{account.name} has {pos.available_quantity} sellable "
                    f"{pos.symbol} but tried to sell {quantity}"
                )
            pos.reserved_quantity += quantity
            return 0, quantity

        if limit_price_cents is not None:
            # A limit buy can cost at most limit x quantity, so reserve exactly that.
            cost = limit_price_cents * quantity
            if account.available_cents < cost:
                raise InsufficientFunds(
                    f"{account.name} has {dollars(account.available_cents)} "
                    f"available but the order needs {dollars(cost)}"
                )
            account.reserved_cents += cost
            return cost, 0

        # A market buy has no limit price to reserve against, so price it off the
        # current book instead. It executes immediately, so nothing needs holding.
        cost, fillable = book.cost_to_fill(Side.BUY, quantity)
        if fillable == 0:
            raise ExchangeError("no sellers available for a market buy")
        if account.available_cents < cost:
            raise InsufficientFunds(
                f"{account.name} has {dollars(account.available_cents)} available "
                f"but filling {fillable} at market would cost {dollars(cost)}"
            )
        return 0, 0

    def _settle(self, symbol: str, trade: Trade) -> TradeRecord:
        """Gate 3: move the cash and the shares, and release what was reserved."""
        buy_order = self.session.get(OrderRecord, trade.buy_order_id)
        sell_order = self.session.get(OrderRecord, trade.sell_order_id)
        buyer = self.session.get(Account, buy_order.account_id)
        seller = self.session.get(Account, sell_order.account_id)

        notional = trade.price * trade.quantity

        # Buyer: pay, receive shares, release the reservation this fill used up.
        # The reservation was made at the buyer's own limit price, which may be
        # higher than the price they actually got -- the difference simply
        # becomes available cash again.
        if buy_order.limit_price_cents is not None:
            released = buy_order.limit_price_cents * trade.quantity
            buyer.reserved_cents -= released
            buy_order.reserved_cents -= released
        buyer.cash_cents -= notional
        self.position(buyer.id, symbol).quantity += trade.quantity

        # Seller: deliver shares, receive cash.
        seller_pos = self.position(seller.id, symbol)
        seller_pos.quantity -= trade.quantity
        seller_pos.reserved_quantity -= trade.quantity
        sell_order.reserved_quantity -= trade.quantity
        seller.cash_cents += notional

        buy_order.filled_quantity += trade.quantity
        sell_order.filled_quantity += trade.quantity
        for o in (buy_order, sell_order):
            o.status = (OrderStatus.FILLED if o.remaining == 0
                        else OrderStatus.PARTIAL)

        record = TradeRecord(
            symbol=symbol, price_cents=trade.price, quantity=trade.quantity,
            buy_order_id=buy_order.id, sell_order_id=sell_order.id,
            buyer_account_id=buyer.id, seller_account_id=seller.id,
        )
        self.session.add(record)
        self.session.flush()
        return record

    def _finalize(self, record: OrderRecord, book: OrderBook) -> None:
        """A market order that ran out of book keeps nothing reserved."""
        if record.remaining > 0 and record.is_market:
            self._release(record)
            record.status = OrderStatus.EXPIRED

    def _release(self, record: OrderRecord) -> None:
        """Hand back whatever this order still has set aside."""
        account = self.session.get(Account, record.account_id)
        if record.reserved_cents:
            account.reserved_cents -= record.reserved_cents
            record.reserved_cents = 0
        if record.reserved_quantity:
            pos = self.position(record.account_id, record.symbol)
            pos.reserved_quantity -= record.reserved_quantity
            record.reserved_quantity = 0

    def cancel_order(self, order_id: int) -> OrderRecord:
        record = self.session.get(OrderRecord, order_id)
        if record is None:
            raise ExchangeError(f"no order {order_id}")
        if record.status in (OrderStatus.FILLED, OrderStatus.CANCELLED,
                             OrderStatus.EXPIRED):
            raise ExchangeError(f"order {order_id} is already {record.status.value}")

        self.book(record.symbol).cancel(order_id)
        self._release(record)
        record.status = OrderStatus.CANCELLED
        self.session.commit()
        self.session.refresh(record)
        return record

    # -- reading ------------------------------------------------------------

    def portfolio(self, account_name: str) -> dict:
        account = self.get_account(account_name)
        positions = self.session.exec(
            select(Position).where(Position.account_id == account.id)
        ).all()
        return {
            "name": account.name,
            "cash_cents": account.cash_cents,
            "reserved_cents": account.reserved_cents,
            "available_cents": account.available_cents,
            "positions": [
                {"symbol": p.symbol, "quantity": p.quantity,
                 "reserved": p.reserved_quantity}
                for p in positions if p.quantity or p.reserved_quantity
            ],
        }
