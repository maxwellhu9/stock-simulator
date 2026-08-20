"""HTTP API for the paper exchange.

The one structural thing worth noticing: order books live for the lifetime of
the PROCESS, database sessions live for the lifetime of a REQUEST. `_books` is
created once at startup and handed to every request's Exchange, which is what
lets a resting order placed by one request still be there for the next one.

On startup the books are rebuilt from the database, so a deploy or a crash does
not strand anyone's open orders.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from .db import create_tables, engine, get_session
from .events import bus
from .marketmaker import MarketMaker, fetch_real_prices
from .exchange import (
    Exchange,
    ExchangeError,
    InsufficientFunds,
    InsufficientShares,
    UnknownAccount,
)
from .models import Account, OrderRecord, Position, TradeRecord
from .orderbook import OrderBook, Side
from .schemas import (
    BookOut,
    CreateAccountRequest,
    DepositRequest,
    Level,
    Money,
    OrderOut,
    PlaceOrderRequest,
    PlaceOrderResponse,
    PortfolioOut,
    PositionOut,
    TradeOut,
)

# Process-wide, shared by every request. See module docstring.
_books: dict[str, OrderBook] = {}

SYMBOLS = ["AAPL", "NVDA", "MSFT"]
TICK_SECONDS = 3.0
_maker: MarketMaker | None = None


async def _run_market_maker() -> None:
    """Quote continuously so the book is never empty.

    Each tick runs in a worker thread because the exchange is synchronous --
    doing that work on the event loop would stall every WebSocket in the process
    for the duration.
    """
    assert _maker is not None
    while True:
        try:
            for symbol in SYMBOLS:
                await asyncio.to_thread(_tick_once, symbol)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a quoting failure must not kill the loop
            print(f"[market-maker] {type(exc).__name__}: {exc}")
        await asyncio.sleep(TICK_SECONDS)


def _tick_once(symbol: str) -> None:
    with Session(engine) as session:
        _maker.tick(session, symbol)
        if bus.subscriber_count(symbol):
            ex = Exchange(session, books=_books)
            bus.publish(symbol, {
                "type": "update",
                "book": _book_payload(ex, symbol).model_dump(mode="json"),
                "trades": [],
            })


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _maker
    create_tables()
    bus.bind_loop(asyncio.get_running_loop())
    with Session(engine) as session:
        restored = Exchange(session, books=_books).load_books()
    print(f"[startup] restored {restored} open orders into the books")

    mids = await asyncio.to_thread(fetch_real_prices, SYMBOLS)
    print("[startup] seed prices: "
          + ", ".join(f"{s} {p/100:,.2f}" for s, p in mids.items()))
    _maker = MarketMaker(_books, mids)
    with Session(engine) as session:
        _maker.ensure_account(session)

    task = asyncio.create_task(_run_market_maker())
    yield
    task.cancel()
    _books.clear()


app = FastAPI(
    title="Paper Exchange",
    description="A trading exchange with a real matching engine and real accounting.",
    version="0.1.0",
    lifespan=lifespan,
)


# The React app runs on a different port, which the browser treats as a
# different origin and blocks by default. Origins come from the environment so
# a deployment can name its real domain without a code change; the defaults are
# the local dev ports (Vite) and the containerised frontend (nginx on 8080).
_DEFAULT_ORIGINS = (
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:5174,http://127.0.0.1:5174,"
    "http://localhost:8080,http://127.0.0.1:8080"
)
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_exchange(session: Session = Depends(get_session)) -> Exchange:
    return Exchange(session, books=_books)


def _http(exc: ExchangeError) -> HTTPException:
    """Translate a domain error into the right HTTP status.

    404 for "that does not exist", 422 for "you cannot afford that" -- the
    request was well-formed, it just violates a business rule.
    """
    if isinstance(exc, UnknownAccount):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, (InsufficientFunds, InsufficientShares)):
        return HTTPException(status_code=422, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


# -- accounts ---------------------------------------------------------------


@app.post("/accounts", response_model=PortfolioOut, status_code=201, tags=["accounts"])
def create_account(body: CreateAccountRequest, ex: Exchange = Depends(get_exchange)):
    existing = ex.session.exec(
        select(Account).where(Account.name == body.name)
    ).first()
    if existing:
        raise HTTPException(409, f"account {body.name!r} already exists")
    ex.open_account(body.name, body.initial_cash_cents)
    return _portfolio(ex, body.name)


@app.get("/accounts/{name}", response_model=PortfolioOut, tags=["accounts"])
def get_portfolio(name: str, ex: Exchange = Depends(get_exchange)):
    try:
        return _portfolio(ex, name)
    except ExchangeError as exc:
        raise _http(exc) from exc


@app.post("/accounts/{name}/deposit", response_model=PortfolioOut, tags=["accounts"])
def deposit(name: str, body: DepositRequest, ex: Exchange = Depends(get_exchange)):
    try:
        account = ex.get_account(name)
    except ExchangeError as exc:
        raise _http(exc) from exc
    account.cash_cents += body.amount_cents
    ex.session.commit()
    return _portfolio(ex, name)


def _portfolio(ex: Exchange, name: str) -> PortfolioOut:
    account = ex.get_account(name)
    positions = ex.session.exec(
        select(Position).where(Position.account_id == account.id)
    ).all()
    return PortfolioOut(
        name=account.name,
        cash=Money.of(account.cash_cents),
        reserved=Money.of(account.reserved_cents),
        available=Money.of(account.available_cents),
        positions=[PositionOut.of(p) for p in positions
                   if p.quantity or p.reserved_quantity],
    )


# -- orders -----------------------------------------------------------------


@app.post("/orders", response_model=PlaceOrderResponse, status_code=201, tags=["orders"])
def place_order(body: PlaceOrderRequest, ex: Exchange = Depends(get_exchange)):
    try:
        order, trades = ex.place_order(
            account_name=body.account, symbol=body.symbol.upper(), side=body.side,
            quantity=body.quantity, limit_price_cents=body.limit_price_cents,
        )
    except ExchangeError as exc:
        raise _http(exc) from exc
    trades_out = [TradeOut.of(t) for t in trades]
    _publish(ex, order.symbol, trades_out)
    return PlaceOrderResponse(order=OrderOut.of(order), trades=trades_out)


@app.delete("/orders/{order_id}", response_model=OrderOut, tags=["orders"])
def cancel_order(order_id: int, ex: Exchange = Depends(get_exchange)):
    try:
        record = ex.cancel_order(order_id)
    except ExchangeError as exc:
        raise _http(exc) from exc
    _publish(ex, record.symbol, [])
    return OrderOut.of(record)


def _publish(ex: Exchange, symbol: str, trades: list[TradeOut]) -> None:
    """Tell every watcher of this symbol that the book moved."""
    if bus.subscriber_count(symbol) == 0:
        return
    bus.publish(symbol, {
        "type": "update",
        "book": _book_payload(ex, symbol).model_dump(mode="json"),
        "trades": [t.model_dump(mode="json") for t in trades],
    })


@app.get("/orders", response_model=list[OrderOut], tags=["orders"])
def list_orders(account: str | None = None, symbol: str | None = None,
                limit: int = Query(50, le=500),
                ex: Exchange = Depends(get_exchange)):
    stmt = select(OrderRecord)
    if account:
        try:
            stmt = stmt.where(OrderRecord.account_id == ex.get_account(account).id)
        except ExchangeError as exc:
            raise _http(exc) from exc
    if symbol:
        stmt = stmt.where(OrderRecord.symbol == symbol.upper())
    stmt = stmt.order_by(OrderRecord.id.desc()).limit(limit)
    return [OrderOut.of(o) for o in ex.session.exec(stmt).all()]


# -- market data ------------------------------------------------------------


@app.get("/book/{symbol}", response_model=BookOut, tags=["market"])
def get_book(symbol: str, levels: int = Query(5, ge=1, le=50),
             ex: Exchange = Depends(get_exchange)):
    return _book_payload(ex, symbol.upper(), levels)


def _book_payload(ex: Exchange, symbol: str, levels: int = 8) -> BookOut:
    book = ex.book(symbol)
    return BookOut(
        symbol=symbol,
        bids=[Level(price=Money.of(p), quantity=q)
              for p, q in book.depth(Side.BUY, levels)],
        asks=[Level(price=Money.of(p), quantity=q)
              for p, q in book.depth(Side.SELL, levels)],
        best_bid=None if book.best_bid is None else Money.of(book.best_bid),
        best_ask=None if book.best_ask is None else Money.of(book.best_ask),
        spread=None if book.spread is None else Money.of(book.spread),
    )


@app.get("/trades/{symbol}", response_model=list[TradeOut], tags=["market"])
def get_trades(symbol: str, limit: int = Query(50, le=500),
               ex: Exchange = Depends(get_exchange)):
    stmt = (select(TradeRecord)
            .where(TradeRecord.symbol == symbol.upper())
            .order_by(TradeRecord.id.desc()).limit(limit))
    return [TradeOut.of(t) for t in ex.session.exec(stmt).all()]


@app.websocket("/ws/{symbol}")
async def market_socket(websocket: WebSocket, symbol: str):
    """One long-lived connection per browser tab watching one symbol.

    Sends a full snapshot on connect so the client starts correct, then an
    update every time the book moves.
    """
    symbol = symbol.upper()
    await bus.connect(symbol, websocket)
    try:
        with Session(engine) as session:
            ex = Exchange(session, books=_books)
            recent = session.exec(
                select(TradeRecord).where(TradeRecord.symbol == symbol)
                .order_by(TradeRecord.id.desc()).limit(20)
            ).all()
            await websocket.send_json({
                "type": "snapshot",
                "book": _book_payload(ex, symbol).model_dump(mode="json"),
                "trades": [TradeOut.of(t).model_dump(mode="json") for t in recent],
            })
        while True:
            # We do not expect client messages; this await is how we notice a
            # disconnect. Without it the coroutine would exit immediately.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        bus.disconnect(symbol, websocket)


@app.get("/symbols", tags=["market"])
def symbols():
    """Which symbols are tradeable, and where the maker is quoting them."""
    return [
        {"symbol": s,
         "mid": {"cents": _maker.mids[s], "display": f"{_maker.mids[s] / 100:,.2f}"}}
        for s in SYMBOLS
    ] if _maker else []


@app.get("/health", tags=["market"])
def health():
    return {
        "status": "ok",
        "symbols": sorted(_books),
        "watchers": {s: bus.subscriber_count(s) for s in sorted(_books)},
    }
