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
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from .db import create_tables, engine, get_session
from .events import bus
from .pnl import cost_basis
from .agents import Population
from .market_sim import MarketSim, fetch_real_prices, last_traded
from .exchange import (
    Exchange,
    ExchangeError,
    InsufficientFunds,
    InsufficientShares,
    UnknownAccount,
)
from .models import Account, OrderRecord, Position, TradeRecord
from .orderbook import OrderBook, Side
from .scenarios import SCENARIOS
from .schemas import (
    BookOut,
    EventOut,
    NewsIn,
    RunningScenario,
    ScenarioIn,
    ScenarioOut,
    Candle,
    ControlsIn,
    PopulationIn,
    ShockIn,
    ShockOut,
    SimStateOut,
    SymbolState,
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
BASE_TICK_SECONDS = 1.0

_sim: MarketSim | None = None
_speed = 1.0
_paused = False
# Highest trade id already pushed to watchers, per symbol, so each update
# carries only what is new.
_published: dict[str, int] = {}


async def _run_market() -> None:
    """Let the agents trade, forever.

    Each tick runs in a worker thread because the exchange is synchronous --
    doing that work on the event loop would stall every WebSocket in the process
    for the duration.
    """
    assert _sim is not None
    loop = asyncio.get_running_loop()
    next_at = loop.time()
    while True:
        try:
            if not _paused:
                await asyncio.to_thread(_run_scenario_steps)
                for symbol in SYMBOLS:
                    await asyncio.to_thread(_tick_once, symbol)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # one bad tick must not stop the market
            print(f"[market] {type(exc).__name__}: {exc}")

        # Schedule against the clock rather than sleeping a full period after
        # the work. Otherwise every cycle is one second PLUS however long the
        # ticks took, and "1x" quietly runs about 30% slow.
        next_at += BASE_TICK_SECONDS / _speed
        delay = next_at - loop.time()
        if delay < 0:
            # Fell behind -- the work took longer than a period. Resume from
            # now instead of firing a burst of back-to-back ticks to catch up.
            next_at = loop.time()
            delay = 0
        await asyncio.sleep(delay)


def _run_scenario_steps() -> None:
    with Session(engine) as session:
        _sim.run_due(session)


def _tick_once(symbol: str) -> None:
    with Session(engine) as session:
        _sim.tick(session, symbol)
        _publish_since_last(session, symbol)


def _publish_since_last(session: Session, symbol: str) -> None:
    """Push the current book plus any trades watchers have not seen yet."""
    if bus.subscriber_count(symbol) == 0:
        _published[symbol] = _latest_trade_id(session, symbol)
        return
    since = _published.get(symbol, 0)
    new = session.exec(
        select(TradeRecord)
        .where(TradeRecord.symbol == symbol)
        .where(TradeRecord.id > since)
        .order_by(TradeRecord.id)
    ).all()
    if new:
        _published[symbol] = new[-1].id
    ex = Exchange(session, books=_books)
    bus.publish(symbol, {
        "type": "update",
        "book": _book_payload(ex, symbol).model_dump(mode="json"),
        # Capped: a fast market can print hundreds of trades between pushes,
        # and the client only ever shows the most recent few.
        "trades": [t.model_dump(mode="json")
                   for t in _trades_out(session, new[-40:])],
        "last": _money(_sim.last.get(symbol)) if _sim else None,
    })


def _latest_trade_id(session: Session, symbol: str) -> int:
    t = session.exec(
        select(TradeRecord).where(TradeRecord.symbol == symbol)
        .order_by(TradeRecord.id.desc())
    ).first()
    return t.id if t else 0


def _money(cents: int | None) -> dict | None:
    return None if cents is None else Money.of(cents).model_dump()


# Account names never change, so their display labels can be cached forever.
_labels: dict[int, str] = {}


def _label(session: Session, account_id: int) -> str:
    """'sim:AAPL:momentum_3' -> 'momentum'. People keep their own names."""
    if account_id not in _labels:
        account = session.get(Account, account_id)
        name = account.name if account else "?"
        if name.startswith("sim:"):
            kind = name.split(":")[-1].rsplit("_", 1)[0]
            name = "big order" if kind == "shock" else kind
        _labels[account_id] = name
    return _labels[account_id]


def _trades_out(session: Session, rows) -> list[TradeOut]:
    return [TradeOut.of(t, buyer=_label(session, t.buyer_account_id),
                        seller=_label(session, t.seller_account_id))
            for t in rows]


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _sim
    create_tables()
    bus.bind_loop(asyncio.get_running_loop())
    with Session(engine) as session:
        restored = Exchange(session, books=_books).load_books()
    print(f"[startup] restored {restored} open orders into the books")

    # Pick up where the market left off. Only a symbol that has never traded
    # takes its starting price from the real one -- reseeding a market that
    # already has a book and a history would open a gap between the two and
    # set off a selloff (or rally) that nobody caused.
    with Session(engine) as session:
        seeds = last_traded(session, SYMBOLS)
    fresh = [s for s in SYMBOLS if s not in seeds]
    if fresh:
        seeds.update(await asyncio.to_thread(fetch_real_prices, fresh))
    print("[startup] prices: " + ", ".join(
        f"{s} {seeds[s]/100:,.2f}{' (real)' if s in fresh else ''}" for s in SYMBOLS))

    for symbol in SYMBOLS:
        _books.setdefault(symbol, OrderBook(symbol))
    _sim = MarketSim(_books, seeds)
    with Session(engine) as session:
        orphans = _sim.cancel_orphans(session)
        print(f"[startup] cancelled {orphans} orders left by a previous run's agents")
        _sim.ensure_accounts(session)
        for symbol in SYMBOLS:
            _published[symbol] = _latest_trade_id(session, symbol)

    task = asyncio.create_task(_run_market())
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
    basis = cost_basis(ex.session, account.id)

    out: list[PositionOut] = []
    held_value = unrealized = 0
    for p in positions:
        if not (p.quantity or p.reserved_quantity):
            continue
        po = PositionOut.of(p)
        last = _last_price(ex, p.symbol)
        b = basis.get(p.symbol)
        if last is not None:
            value = last * p.quantity
            po.last_price = Money.of(last)
            po.market_value = Money.of(value)
            held_value += value
            if b and b.avg_cost is not None:
                po.avg_cost = Money.of(b.avg_cost)
                gain = value - b.cost_cents
                po.unrealized_pnl = Money.of(gain)
                unrealized += gain
        out.append(po)

    realized = sum(b.realized_cents for b in basis.values())
    return PortfolioOut(
        name=account.name,
        cash=Money.of(account.cash_cents),
        reserved=Money.of(account.reserved_cents),
        available=Money.of(account.available_cents),
        positions=out,
        positions_value=Money.of(held_value),
        total_value=Money.of(account.cash_cents + held_value),
        unrealized_pnl=Money.of(unrealized),
        realized_pnl=Money.of(realized),
    )


def _last_price(ex: Exchange, symbol: str) -> int | None:
    if _sim is not None and symbol in _sim.last:
        return _sim.last[symbol]
    t = ex.session.exec(
        select(TradeRecord).where(TradeRecord.symbol == symbol)
        .order_by(TradeRecord.id.desc())
    ).first()
    return t.price_cents if t else None


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
    trades_out = _trades_out(ex.session, trades)
    if _sim is not None:
        for t in trades:
            _sim.record_trade(order.symbol, t.price_cents)
    _publish_since_last(ex.session, order.symbol)
    return PlaceOrderResponse(order=OrderOut.of(order), trades=trades_out)


@app.delete("/orders/{order_id}", response_model=OrderOut, tags=["orders"])
def cancel_order(order_id: int, ex: Exchange = Depends(get_exchange)):
    try:
        record = ex.cancel_order(order_id)
    except ExchangeError as exc:
        raise _http(exc) from exc
    _publish_since_last(ex.session, record.symbol)
    return OrderOut.of(record)



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
    return _trades_out(ex.session, ex.session.exec(stmt).all())


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
                "trades": [t.model_dump(mode="json")
                           for t in _trades_out(session, recent)],
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
    """Which symbols are tradeable, and their last traded price."""
    return [
        {"symbol": s, "mid": Money.of(_sim.last[s]).model_dump()}
        for s in SYMBOLS
    ] if _sim else []


@app.get("/candles/{symbol}", response_model=list[Candle], tags=["market"])
def candles(symbol: str, seconds: int = Query(5, ge=1, le=3600),
            limit: int = Query(120, ge=1, le=600),
            ex: Exchange = Depends(get_exchange)):
    """Trades bucketed into fixed time windows, newest last."""
    rows = ex.session.exec(
        select(TradeRecord).where(TradeRecord.symbol == symbol.upper())
        .order_by(TradeRecord.id.desc()).limit(limit * 60)
    ).all()
    # Only the window the caller asked for. Without this, a market that just
    # restarted fills "the past 5 minutes" with buckets from hours earlier,
    # and the chart draws the overnight gap as one long flat line.
    cutoff = time.time() - seconds * limit
    buckets: dict[int, Candle] = {}
    for t in reversed(rows):
        if t.created_at.timestamp() < cutoff:
            continue
        start = int(t.created_at.timestamp()) // seconds * seconds
        c = buckets.get(start)
        if c is None:
            buckets[start] = Candle(t=start, open=t.price_cents, high=t.price_cents,
                                    low=t.price_cents, close=t.price_cents,
                                    volume=t.quantity)
        else:
            c.high = max(c.high, t.price_cents)
            c.low = min(c.low, t.price_cents)
            c.close = t.price_cents
            c.volume += t.quantity
    return [buckets[k] for k in sorted(buckets)][-limit:]


# -- sandbox controls -------------------------------------------------------


def _sim_state() -> SimStateOut:
    assert _sim is not None
    p = _sim.population
    return SimStateOut(
        population=PopulationIn(value=p.value, momentum=p.momentum,
                                noise=p.noise, maker=p.maker),
        sentiment=_sim.sentiment, speed=_speed, paused=_paused,
        random_news=_sim.random_news,
        scenario=None if _sim.scenario is None else RunningScenario(
            key=_sim.scenario[0], name=_sim.scenario[1],
            ends_in=max(0.0, _sim.scenario[2] - time.time()),
        ),
        symbols=[SymbolState(symbol=s, last=Money.of(_sim.last[s]),
                             fair=Money.of(_sim.fair[s])) for s in SYMBOLS],
    )


@app.get("/sim", response_model=SimStateOut, tags=["sandbox"])
def get_sim():
    if _sim is None:
        raise HTTPException(503, "market is still starting")
    return _sim_state()


@app.get("/sim/history/{symbol}", tags=["sandbox"])
def sim_history(symbol: str):
    """Price against fair value, one point per tick, oldest first."""
    symbol = symbol.upper()
    if _sim is None or symbol not in _sim.history:
        raise HTTPException(404, f"no simulated market for {symbol}")
    return [{"t": round(t, 2), "price": p, "fair": f} for t, p, f in _sim.history[symbol]]


@app.put("/sim/population", response_model=SimStateOut, tags=["sandbox"])
def set_population(body: PopulationIn, ex: Exchange = Depends(get_exchange)):
    if _sim is None:
        raise HTTPException(503, "market is still starting")
    _sim.set_population(ex.session, Population(
        value=body.value, momentum=body.momentum,
        noise=body.noise, maker=body.maker,
    ))
    return _sim_state()


@app.put("/sim/controls", response_model=SimStateOut, tags=["sandbox"])
def set_controls(body: ControlsIn):
    global _speed, _paused
    if _sim is None:
        raise HTTPException(503, "market is still starting")
    if body.sentiment is not None:
        _sim.sentiment = body.sentiment
    if body.speed is not None:
        _speed = body.speed
    if body.paused is not None:
        _paused = body.paused
    if body.random_news is not None:
        _sim.random_news = body.random_news
    return _sim_state()


@app.get("/sim/events", response_model=list[EventOut], tags=["sandbox"])
def sim_events(symbol: str | None = None, limit: int = Query(20, ge=1, le=60)):
    """Recent news and scenario steps, newest first. Market-wide events always show."""
    if _sim is None:
        return []
    sym = symbol.upper() if symbol else None
    rows = [e for e in reversed(_sim.events)
            if sym is None or e.symbol is None or e.symbol == sym]
    return [EventOut(t=e.t, symbol=e.symbol, kind=e.kind, headline=e.headline,
                     impact_pct=e.impact * 100) for e in rows[:limit]]


@app.post("/sim/news", response_model=EventOut, tags=["sandbox"])
def post_news(body: NewsIn):
    symbol = body.symbol.upper()
    if _sim is None or symbol not in _sim.fair:
        raise HTTPException(404, f"no simulated market for {symbol}")
    e = _sim.news(symbol, good=body.good)
    return EventOut(t=e.t, symbol=e.symbol, kind=e.kind, headline=e.headline,
                    impact_pct=e.impact * 100)


@app.get("/sim/scenarios", response_model=list[ScenarioOut], tags=["sandbox"])
def list_scenarios():
    return [ScenarioOut(key=s.key, name=s.name, description=s.description,
                        seconds=int(s.duration)) for s in SCENARIOS.values()]


@app.post("/sim/scenario", response_model=SimStateOut, tags=["sandbox"])
def run_scenario(body: ScenarioIn, ex: Exchange = Depends(get_exchange)):
    symbol = body.symbol.upper()
    if _sim is None or symbol not in _sim.fair:
        raise HTTPException(404, f"no simulated market for {symbol}")
    if body.key == "calm":
        _sim.calm(ex.session)
    elif body.key in SCENARIOS:
        _sim.start_scenario(ex.session, body.key, symbol)
    else:
        raise HTTPException(404, f"no scenario {body.key!r}")
    _publish_since_last(ex.session, symbol)
    return _sim_state()


@app.post("/sim/shock", response_model=ShockOut, tags=["sandbox"])
def shock(body: ShockIn, ex: Exchange = Depends(get_exchange)):
    """Drop one huge market order into the book and report what it did."""
    symbol = body.symbol.upper()
    if _sim is None or symbol not in _sim.last:
        raise HTTPException(404, f"no simulated market for {symbol}")
    r = _sim.shock(ex.session, symbol, body.side, body.quantity)
    _publish_since_last(ex.session, symbol)
    return ShockOut(
        side=body.side, requested=r.requested, filled=r.filled,
        fill_rate=r.fill_rate, price_before=Money.of(r.mid_before),
        avg_fill=Money.of(r.avg_fill), slippage_pct=r.slippage * 100,
        orders_hit=r.orders_hit,
    )


@app.get("/health", tags=["market"])
def health():
    return {
        "status": "ok",
        "symbols": sorted(_books),
        "watchers": {s: bus.subscriber_count(s) for s in sorted(_books)},
    }
