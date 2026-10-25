"""News and scenarios. Time is passed in explicitly so nothing here sleeps."""

import random

import pytest
from sqlmodel import select

from app.agents import Population
from app.market_sim import MarketSim, PREFIX
from app.models import Account, OrderRecord
from app.orderbook import OrderBook


@pytest.fixture
def sim(session):
    random.seed(21)
    s = MarketSim({"X": OrderBook("X")}, {"X": 10_000})
    s.random_news = False  # tests decide when news happens
    s.ensure_accounts(session)
    for _ in range(8):
        s.tick(session, "X")
    return s


def _open_maker_orders(session):
    return session.exec(
        select(OrderRecord)
        .join(Account, Account.id == OrderRecord.account_id)
        .where(Account.name.like(f"{PREFIX}:%:maker_%"))
        .where(OrderRecord.status.in_(["OPEN", "PARTIAL"]))
    ).all()


def test_news_moves_fair_value_by_its_impact(sim):
    before = sim.fair["X"]
    event = sim.news("X", good=True)
    assert event.impact > 0
    assert sim.fair["X"] == pytest.approx(before * (1 + event.impact), abs=1)
    assert sim.events[-1] is event

    event = sim.news("X", good=False)
    assert event.impact < 0


def test_changing_the_crowd_pulls_the_old_crowds_quotes(session, sim):
    """Regression: rebuilt makers used to leave their quotes on the book forever."""
    assert _open_maker_orders(session), "makers should be quoting before the change"
    sim.set_population(session, Population(value=6, momentum=5, noise=8, maker=0))
    assert _open_maker_orders(session) == []


def test_flash_crash_runs_in_order_then_restores(session, sim):
    t0 = 1_000_000.0
    sim.start_scenario(session, "flash_crash", "X", now=t0)
    assert sim.population.maker == 0
    assert _open_maker_orders(session) == []
    assert sim.scenario[1] == "Flash crash"

    sim.run_due(session, now=t0 + 2.5)
    assert any("huge seller" in e.headline for e in sim.events)

    sim.run_due(session, now=t0 + 15.5)
    assert sim.scenario is None
    assert sim.population.maker == 2           # makers are back
    assert sim.events[-1].headline == "Things calm down"


def test_flash_crash_seller_trades_far_below_the_old_price(session, sim):
    """Regression: a plain market order ran out of book a fraction of a percent
    down, so the "crash" was invisible. The seller now sells down to a floor."""
    t0 = 1_500_000.0
    before = sim.last["X"]
    sim.start_scenario(session, "flash_crash", "X", now=t0)
    sim.run_due(session, now=t0 + 2.5)
    sim.tick(session, "X")
    low = min(p for _, p, _ in list(sim.history["X"])[-2:])
    assert low < before * 0.96


def test_bubble_restores_the_crowd_and_mood_afterwards(session, sim):
    t0 = 2_000_000.0
    sim.start_scenario(session, "bubble", "X", now=t0)
    assert sim.population.momentum == 20 and sim.sentiment > 0
    assert any(e.kind == "good" for e in sim.events)

    sim.run_due(session, now=t0 + 61)
    assert sim.population == Population()
    assert sim.sentiment == 0.0


def test_calm_down_cancels_a_running_scenario(session, sim):
    sim.start_scenario(session, "panic", "X", now=3_000_000.0)
    sim.calm(session, now=3_000_005.0)
    assert sim.scenario is None and sim._plan == []
    assert sim.population == Population()


def test_unknown_scenario_is_rejected(session, sim):
    with pytest.raises(KeyError):
        sim.start_scenario(session, "moon", "X")


def test_a_stock_does_not_repeat_its_recent_headlines(sim):
    headlines = [sim.news("X", good=True).headline for _ in range(4)]
    assert len(set(headlines)) == 4
