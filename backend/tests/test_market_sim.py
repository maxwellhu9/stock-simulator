"""The simulated market. These pin down invariants, not tuned outcomes.

Statistical claims -- "momentum makes it more volatile" -- belong in an
experiment averaged across many seeds, not in a test that runs once. What CAN be
asserted every time is what must never break: money and shares are conserved,
agents get no special treatment, the book does not fill with abandoned orders.
"""

import random

import pytest
from sqlmodel import select

from app.agents import (
    MarketMakerAgent,
    MarketState,
    MomentumTrader,
    Population,
    ValueTrader,
)
from app.market_sim import ORDER_TTL, MarketSim
from app.models import Account, Position, TradeRecord
from app.orderbook import OrderBook, Side


@pytest.fixture
def sim(session):
    random.seed(11)
    books = {"X": OrderBook("X")}
    s = MarketSim(books, {"X": 10_000})
    s.ensure_accounts(session)
    return s


def _totals(session):
    cash = sum(a.cash_cents for a in session.exec(select(Account)).all())
    shares = sum(p.quantity for p in session.exec(select(Position)).all())
    return cash, shares


def test_money_and_shares_are_conserved(session, sim):
    """Hundreds of agent trades, and not one cent or share appears or vanishes."""
    before = _totals(session)
    for _ in range(80):
        sim.tick(session, "X")
    trades = session.exec(select(TradeRecord)).all()

    assert len(trades) > 100, "the market should actually be trading"
    assert _totals(session) == before


def test_price_is_whatever_last_traded(session, sim):
    """Nothing computes the price. It is the most recent trade, full stop."""
    for _ in range(30):
        sim.tick(session, "X")
    last = session.exec(
        select(TradeRecord).order_by(TradeRecord.id.desc())
    ).first()
    assert sim.last["X"] == last.price_cents


def test_agents_get_no_special_path(session, sim):
    """An agent that cannot pay is refused, exactly like a human."""
    from app.market_sim import account_name

    broke = session.exec(
        select(Account).where(Account.name == account_name("X", "value_0"))
    ).one()
    broke.cash_cents = 0
    session.commit()

    agent = next(a for a in sim.agents["X"] if a.name == "value_0")
    from app.agents import Intent
    assert sim._submit(
        __import__("app.exchange", fromlist=["Exchange"]).Exchange(session, books=sim.books),
        "X", agent, Intent(Side.BUY, 10, 10_000, agent.name),
    ) == []


def test_unfilled_agent_orders_expire(session, sim):
    """Without expiry, stale limit orders pile up and the book fills with junk."""
    for _ in range(ORDER_TTL * 6):
        sim.tick(session, "X")
    ages = [sim.ticks["X"] - placed for _, placed in sim._working["X"]]
    assert all(age < ORDER_TTL for age in ages)


def test_shock_reports_what_actually_executed(session, sim):
    """A market order bigger than the book only partially fills -- say so."""
    for _ in range(15):
        sim.tick(session, "X")
    result = sim.shock(session, "X", Side.SELL, 1_000_000)

    assert result.requested == 1_000_000
    assert 0 < result.filled < result.requested
    assert result.fill_rate < 0.5
    assert result.avg_fill <= result.mid_before  # selling never helps the price


def test_population_can_be_changed_live(session, sim):
    sim.set_population(session, Population(value=0, momentum=3, noise=2, maker=1))
    kinds = [a.kind for a in sim.agents["X"]]
    assert kinds.count("value") == 0
    assert kinds.count("momentum") == 3
    assert kinds.count("maker") == 1
    sim.tick(session, "X")  # and the market still runs


def test_value_trader_buys_below_fair_and_sells_above():
    random.seed(3)
    v = ValueTrader("v", fair=10_000, error=0.0)
    cheap = MarketState("X", 9_490, 9_510, 9_500, [])
    rich = MarketState("X", 10_490, 10_510, 10_500, [])
    assert v.act(cheap, OrderBook("X"), fair=10_000)[0].side is Side.BUY
    assert v.act(rich, OrderBook("X"), fair=10_000)[0].side is Side.SELL


def test_momentum_trader_chases_the_move():
    random.seed(3)
    m = MomentumTrader("m", threshold=0.0001)
    m.lookback = 3
    rising = MarketState("X", 10_090, 10_110, 10_100, [],
                         tick_prices=[10_000, 10_030, 10_060, 10_100])
    falling = MarketState("X", 9_890, 9_910, 9_900, [],
                          tick_prices=[10_000, 9_970, 9_930, 9_900])
    assert m.act(rising, OrderBook("X"))[0].side is Side.BUY
    assert m.act(falling, OrderBook("X"))[0].side is Side.SELL


def test_maker_leans_against_its_inventory():
    """Long inventory pushes quotes down so it can sell; short pushes them up."""
    random.seed(3)
    state = MarketState("X", 9_990, 10_010, 10_000, [])
    flat, long_, short = (MarketMakerAgent(n) for n in ("a", "b", "c"))
    long_.inventory, short.inventory = 500, -500

    def best_ask(maker):
        return min(i.price for i in maker.act(state, OrderBook("X")) if i.side is Side.SELL)

    assert best_ask(long_) < best_ask(flat) < best_ask(short)


def test_a_restart_clears_old_agent_orders_but_keeps_peoples(session, sim):
    """Agents from a previous run left orders nobody manages any more."""
    from app.exchange import Exchange
    from app.market_sim import MarketSim
    from app.models import OrderRecord

    for _ in range(10):
        sim.tick(session, "X")
    ex = Exchange(session, books=sim.books)  # same books the sim trades on
    ex.open_account("alice", 1_000_000_00)
    mine, _ = ex.place_order("alice", "X", Side.BUY, 5, 1_00)  # far below market

    restarted = MarketSim(sim.books, {"X": sim.last["X"]})
    assert restarted.cancel_orphans(session) > 0

    assert sim.books["X"].get(mine.id).remaining == 5  # alice's order survived
    still_open = session.exec(
        select(Account.name)
        .join(OrderRecord, Account.id == OrderRecord.account_id)
        .where(OrderRecord.status.in_(["OPEN", "PARTIAL"]))
    ).all()
    assert still_open == ["alice"]


def test_restart_prices_continue_from_the_last_trade(session, sim):
    from app.market_sim import last_traded

    for _ in range(10):
        sim.tick(session, "X")
    assert last_traded(session, ["X", "NEVER_TRADED"]) == {"X": sim.last["X"]}
