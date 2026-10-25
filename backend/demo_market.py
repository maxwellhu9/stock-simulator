"""Run the simulated market with nobody watching, and see what price it finds.

No server, no frontend. Just agents trading through the real matching engine.
"""

import sys

from sqlmodel import Session, SQLModel, create_engine

from app.agents import Population
from app.market_sim import MarketSim
from app.money import format_cents
from app.orderbook import OrderBook, Side

TICKS = int(sys.argv[1]) if len(sys.argv) > 1 else 120
SYMBOL = "ACME"
START = 100_00

engine = create_engine("postgresql+psycopg://localhost:5432/paper_exchange_test")
SQLModel.metadata.drop_all(engine)
SQLModel.metadata.create_all(engine)

books = {SYMBOL: OrderBook(SYMBOL)}
sim = MarketSim(books, {SYMBOL: START})

BLOCKS = "▁▂▃▄▅▆▇█"


def spark(values, width=72):
    if len(values) > width:
        step = len(values) / width
        values = [values[int(i * step)] for i in range(width)]
    lo, hi = min(values), max(values)
    if hi == lo:
        return BLOCKS[0] * len(values)
    return "".join(BLOCKS[min(7, int((v - lo) / (hi - lo) * 7.99))] for v in values)


with Session(engine) as session:
    sim.ensure_accounts(session)
    print(f"\n{sim.population.total()} agents  "
          f"({sim.population.value} value, {sim.population.momentum} momentum, "
          f"{sim.population.noise} noise, {sim.population.maker} makers)")
    print(f"starting price {format_cents(START)}\n")

    prices, fairs, volumes = [], [], []
    for i in range(TICKS):
        n = sim.tick(session, SYMBOL)
        prices.append(sim.last[SYMBOL])
        fairs.append(sim.fair[SYMBOL])
        volumes.append(n)

    book = books[SYMBOL]
    print(f"  price  {spark(prices)}")
    print(f"  fair   {spark(fairs)}")
    print(f"  volume {spark(volumes)}")
    print()
    print(f"  price:   start {format_cents(START)}   end {format_cents(prices[-1])}   "
          f"low {format_cents(min(prices))}   high {format_cents(max(prices))}")
    print(f"  fair:    end {format_cents(fairs[-1])}   "
          f"gap to price {format_cents(abs(prices[-1] - fairs[-1]))}")
    print(f"  trades:  {sum(volumes)} over {TICKS} ticks "
          f"({sum(volumes)/TICKS:.1f} per tick)")
    bb, ba = book.best_bid, book.best_ask
    print(f"  book:    bid {format_cents(bb) if bb else '--'}  "
          f"ask {format_cents(ba) if ba else '--'}  "
          f"spread {format_cents(book.spread) if book.spread else '--'}")
    print(f"           {len(book.depth(Side.BUY, 50))} bid levels, "
          f"{len(book.depth(Side.SELL, 50))} ask levels")
