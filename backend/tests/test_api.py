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
