"""API tests. These drive the real app through HTTP, not the service directly."""

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.events import bus
from app.main import _books, app

TEST_URL = "postgresql+psycopg://localhost:5432/paper_exchange_test"


@pytest.fixture(name="client")
def client_fixture():
    engine = create_engine(TEST_URL)
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    _books.clear()
    bus.reset()

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # Plain TestClient (no context manager) does NOT run lifespan, which is what
    # we want -- lifespan would connect to the development database and rebuild
    # its books, and these tests run against a throwaway one.
    yield TestClient(app)
    app.dependency_overrides.clear()
    engine.dispose()


def mk(client, name, cash="50000.00"):
    return client.post("/accounts", json={"name": name, "initial_cash": cash})


def test_create_and_read_account(client):
    r = mk(client, "alice")
    assert r.status_code == 201
    assert r.json()["cash"] == {"cents": 5000000, "display": "50,000.00"}

    r = client.get("/accounts/alice")
    assert r.status_code == 200
    assert r.json()["available"]["display"] == "50,000.00"


def test_duplicate_account_rejected(client):
    mk(client, "alice")
    assert mk(client, "alice").status_code == 409


def test_unknown_account_is_404(client):
    assert client.get("/accounts/nobody").status_code == 404


def test_place_limit_order_reserves_cash(client):
    mk(client, "alice")
    r = client.post("/orders", json={
        "account": "alice", "symbol": "acme", "side": "buy",
        "quantity": 100, "limit_price": "100.00",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["order"]["symbol"] == "ACME"  # normalised to upper case
    assert body["order"]["status"] == "open"
    assert body["trades"] == []

    p = client.get("/accounts/alice").json()
    assert p["reserved"]["cents"] == 1000000
    assert p["available"]["cents"] == 4000000


def test_insufficient_funds_is_422(client):
    mk(client, "alice", "100.00")
    r = client.post("/orders", json={
        "account": "alice", "symbol": "ACME", "side": "buy",
        "quantity": 100, "limit_price": "100.00",
    })
    assert r.status_code == 422
    assert "available" in r.json()["detail"]


def test_float_price_is_rejected_at_the_boundary(client):
    """JSON numbers are floats. Money must arrive as a string."""
    mk(client, "alice")
    r = client.post("/orders", json={
        "account": "alice", "symbol": "ACME", "side": "buy",
        "quantity": 100, "limit_price": 100.005,
    })
    assert r.status_code == 422


def test_book_reflects_resting_orders(client):
    mk(client, "alice")
    client.post("/orders", json={"account": "alice", "symbol": "ACME",
                                 "side": "buy", "quantity": 100,
                                 "limit_price": "99.50"})
    b = client.get("/book/acme").json()
    assert b["best_bid"]["display"] == "99.50"
    assert b["best_ask"] is None
    assert b["bids"] == [{"price": {"cents": 9950, "display": "99.50"}, "quantity": 100}]


def test_full_trade_round_trip(client):
    mk(client, "alice")
    mk(client, "bob", "0.00")
    # Seed bob with stock directly through the service.
    from app.exchange import Exchange
    from sqlmodel import Session, create_engine
    engine = create_engine(TEST_URL)
    with Session(engine) as s:
        ex = Exchange(s, books=_books)
        ex.position(ex.get_account("bob").id, "ACME").quantity = 500
        s.commit()

    client.post("/orders", json={"account": "alice", "symbol": "ACME",
                                 "side": "buy", "quantity": 100,
                                 "limit_price": "100.00"})
    r = client.post("/orders", json={"account": "bob", "symbol": "ACME",
                                     "side": "sell", "quantity": 100,
                                     "limit_price": "99.00"})
    trades = r.json()["trades"]
    assert len(trades) == 1
    assert trades[0]["price"]["display"] == "100.00"   # alice was resting
    assert trades[0]["notional"]["display"] == "10,000.00"

    assert client.get("/accounts/bob").json()["cash"]["display"] == "10,000.00"
    assert client.get("/trades/ACME").json()[0]["quantity"] == 100


def test_cancel_frees_the_reservation(client):
    mk(client, "alice")
    oid = client.post("/orders", json={"account": "alice", "symbol": "ACME",
                                       "side": "buy", "quantity": 100,
                                       "limit_price": "100.00"}).json()["order"]["id"]
    assert client.delete(f"/orders/{oid}").json()["status"] == "cancelled"
    assert client.get("/accounts/alice").json()["available"]["cents"] == 5000000
    assert client.delete(f"/orders/{oid}").status_code == 400  # already cancelled


def test_list_orders_filters_by_account(client):
    mk(client, "alice")
    mk(client, "carol")
    for who in ("alice", "carol", "alice"):
        client.post("/orders", json={"account": who, "symbol": "ACME",
                                     "side": "buy", "quantity": 10,
                                     "limit_price": "50.00"})
    assert len(client.get("/orders", params={"account": "alice"}).json()) == 2
    assert len(client.get("/orders").json()) == 3


# -- websockets -------------------------------------------------------------


def test_websocket_sends_a_snapshot_on_connect(client):
    mk(client, "alice")
    client.post("/orders", json={"account": "alice", "symbol": "ACME",
                                 "side": "buy", "quantity": 100,
                                 "limit_price": "99.50"})

    with client.websocket_connect("/ws/ACME") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "snapshot"
        assert msg["book"]["best_bid"]["display"] == "99.50"


def test_websocket_pushes_when_the_book_moves(client):
    mk(client, "alice")
    with client.websocket_connect("/ws/ACME") as ws:
        assert ws.receive_json()["type"] == "snapshot"

        client.post("/orders", json={"account": "alice", "symbol": "ACME",
                                     "side": "buy", "quantity": 50,
                                     "limit_price": "98.00"})
        msg = ws.receive_json()
        assert msg["type"] == "update"
        assert msg["book"]["best_bid"]["display"] == "98.00"


def test_websocket_carries_the_trades(client):
    mk(client, "alice")
    mk(client, "bob", "0.00")
    from sqlmodel import Session, create_engine

    from app.exchange import Exchange
    engine = create_engine(TEST_URL)
    with Session(engine) as s:
        ex = Exchange(s, books=_books)
        ex.position(ex.get_account("bob").id, "ACME").quantity = 500
        s.commit()

    client.post("/orders", json={"account": "alice", "symbol": "ACME",
                                 "side": "buy", "quantity": 100,
                                 "limit_price": "100.00"})

    with client.websocket_connect("/ws/ACME") as ws:
        ws.receive_json()  # snapshot
        client.post("/orders", json={"account": "bob", "symbol": "ACME",
                                     "side": "sell", "quantity": 100,
                                     "limit_price": "99.00"})
        msg = ws.receive_json()
        assert len(msg["trades"]) == 1
        assert msg["trades"][0]["price"]["display"] == "100.00"


def test_watchers_are_counted_and_released(client):
    mk(client, "alice")
    client.post("/orders", json={"account": "alice", "symbol": "ACME",
                                 "side": "buy", "quantity": 10,
                                 "limit_price": "50.00"})
    with client.websocket_connect("/ws/ACME") as ws:
        ws.receive_json()
        assert client.get("/health").json()["watchers"]["ACME"] == 1
    assert client.get("/health").json()["watchers"]["ACME"] == 0


# -- sandbox ----------------------------------------------------------------


@pytest.fixture(name="sim_client")
def sim_client_fixture(client):
    """The client fixture plus a live simulated market on the test database."""
    import random

    from sqlmodel import Session, create_engine

    import app.main as main
    from app.market_sim import MarketSim
    from app.orderbook import OrderBook

    random.seed(5)
    engine = create_engine(TEST_URL)
    _books["SIM"] = OrderBook("SIM")
    main._sim = MarketSim(_books, {"SIM": 10_000})
    main._speed, main._paused = 1.0, False
    with Session(engine) as s:
        main._sim.ensure_accounts(s)
        for _ in range(15):
            main._sim.tick(s, "SIM")
    old_symbols = main.SYMBOLS
    main.SYMBOLS = ["SIM"]
    yield client
    main.SYMBOLS = old_symbols
    main._sim = None
    engine.dispose()


def test_sim_state_reports_population_and_prices(sim_client):
    body = sim_client.get("/sim").json()
    assert body["population"] == {"value": 6, "momentum": 5, "noise": 8, "maker": 2}
    assert body["symbols"][0]["symbol"] == "SIM"
    assert body["symbols"][0]["last"]["cents"] > 0


def test_population_can_be_changed_over_http(sim_client):
    r = sim_client.put("/sim/population",
                       json={"value": 0, "momentum": 10, "noise": 3, "maker": 1})
    assert r.status_code == 200
    assert r.json()["population"]["momentum"] == 10


def test_population_is_bounded(sim_client):
    r = sim_client.put("/sim/population",
                       json={"value": 500, "momentum": 0, "noise": 0, "maker": 0})
    assert r.status_code == 422


def test_controls_set_sentiment_speed_and_pause(sim_client):
    r = sim_client.put("/sim/controls",
                       json={"sentiment": -0.5, "speed": 2.0, "paused": True})
    body = r.json()
    assert (body["sentiment"], body["speed"], body["paused"]) == (-0.5, 2.0, True)
    assert sim_client.put("/sim/controls", json={"sentiment": 3}).status_code == 422


def test_shock_reports_what_it_did(sim_client):
    r = sim_client.post("/sim/shock",
                        json={"symbol": "sim", "side": "sell", "quantity": 500_000})
    body = r.json()
    assert r.status_code == 200
    assert body["requested"] == 500_000
    assert 0 < body["filled"] < 500_000  # far bigger than the book
    assert body["slippage_pct"] <= 0


def test_candles_bucket_the_trades(sim_client):
    candles = sim_client.get("/candles/SIM", params={"seconds": 60}).json()
    assert candles, "the simulated trades should produce at least one candle"
    c = candles[-1]
    assert c["low"] <= c["open"] <= c["high"]
    assert c["low"] <= c["close"] <= c["high"]
    assert c["volume"] > 0


def test_portfolio_values_positions_and_trades_name_both_sides(client):
    mk(client, "alice")
    mk(client, "bob", "0.00")
    from sqlmodel import Session, create_engine

    from app.exchange import Exchange
    engine = create_engine(TEST_URL)
    with Session(engine) as s:
        ex = Exchange(s, books=_books)
        ex.position(ex.get_account("bob").id, "ACME").quantity = 500
        s.commit()

    client.post("/orders", json={"account": "bob", "symbol": "ACME", "side": "sell",
                                 "quantity": 100, "limit_price": "100.00"})
    client.post("/orders", json={"account": "alice", "symbol": "ACME", "side": "buy",
                                 "quantity": 100, "limit_price": "100.00"})

    p = client.get("/accounts/alice").json()
    pos = p["positions"][0]
    assert pos["avg_cost"]["display"] == "100.00"
    assert pos["market_value"]["display"] == "10,000.00"
    assert pos["unrealized_pnl"]["cents"] == 0
    assert p["total_value"]["display"] == "50,000.00"  # cash moved into stock

    t = client.get("/trades/ACME").json()[0]
    assert (t["buyer"], t["seller"]) == ("alice", "bob")


def test_sim_history_pairs_price_with_fair_value(sim_client):
    points = sim_client.get("/sim/history/SIM").json()
    assert len(points) == 15  # one per tick the fixture ran
    assert all(p["price"] > 0 and p["fair"] > 0 for p in points)
    assert points == sorted(points, key=lambda p: p["t"])


def test_news_scenarios_and_events_over_http(sim_client):
    import app.main as main
    main._sim.random_news = False

    r = sim_client.post("/sim/news", json={"symbol": "sim", "good": False})
    assert r.status_code == 200 and r.json()["impact_pct"] < 0

    keys = {s["key"] for s in sim_client.get("/sim/scenarios").json()}
    assert {"bubble", "flash_crash", "panic"} <= keys

    state = sim_client.post("/sim/scenario", json={"key": "bubble", "symbol": "SIM"}).json()
    assert state["scenario"]["name"] == "Bubble"
    assert state["population"]["momentum"] == 20

    state = sim_client.post("/sim/scenario", json={"key": "calm", "symbol": "SIM"}).json()
    assert state["scenario"] is None

    headlines = [e["headline"] for e in sim_client.get("/sim/events", params={"symbol": "SIM"}).json()]
    assert headlines[0] == "Things calm down"
    assert "Bubble begins" in headlines

    assert sim_client.post("/sim/scenario", json={"key": "moon", "symbol": "SIM"}).status_code == 404


def test_candles_never_reach_outside_the_requested_window(sim_client):
    """A restart must not fill "the past 5 minutes" with yesterday's trades."""
    import time
    from datetime import datetime, timedelta

    from sqlmodel import Session, create_engine, select

    from app.models import TradeRecord

    engine = create_engine(TEST_URL)
    with Session(engine) as s:
        old = s.exec(select(TradeRecord).where(TradeRecord.symbol == "SIM")).first()
        old.created_at = datetime.now() - timedelta(hours=10)
        s.commit()

    candles = sim_client.get("/candles/SIM", params={"seconds": 5, "limit": 60}).json()
    assert candles and min(c["t"] for c in candles) >= time.time() - 5 * 60 - 5
