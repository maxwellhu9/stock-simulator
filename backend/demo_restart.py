"""Simulate a crash: throw the book away, rebuild it from Postgres."""

from sqlmodel import Session, SQLModel, create_engine

from app.exchange import Exchange
from app.money import dollars
from app.orderbook import Side

engine = create_engine("postgresql+psycopg://localhost:5432/paper_exchange")
SQLModel.metadata.drop_all(engine)
SQLModel.metadata.create_all(engine)

with Session(engine) as session:
    ex = Exchange(session)
    ex.open_account("alice", 50_000_00)
    ex.open_account("carol", 50_000_00)
    ex.open_account("bob", 0)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    session.commit()

    ex.place_order("alice", "ACME", Side.BUY, 100, 100_00)  # first in line
    ex.place_order("carol", "ACME", Side.BUY, 100, 100_00)  # second
    ex.place_order("alice", "ACME", Side.BUY, 200, 99_00)

    print("\nBEFORE — three resting bids")
    print(f"  book:  {ex.book('ACME').depth(Side.BUY)}")
    print(f"  alice reserved: {dollars(ex.portfolio('alice')['reserved_cents'])}")

    print("\n\n*** process dies, server restarts ***")
    crashed = Exchange(session)   # brand new object: empty books
    print(f"\n  book:  {crashed.book('ACME').depth(Side.BUY)}   <-- gone")
    print(f"  alice reserved: {dollars(crashed.portfolio('alice')['reserved_cents'])}"
          "   <-- but her money is STILL locked up")
    print("  Her orders are marked 'open' in Postgres but cannot be traded against.")
    print("  Without a rebuild, that cash is stranded permanently.")

    n = crashed.load_books()
    print(f"\n\nAFTER load_books() — replayed {n} open orders from Postgres")
    print(f"  book:  {crashed.book('ACME').depth(Side.BUY)}")

    print("\n\nAnd time priority survived. Bob sells 100 at $100:")
    _, trades = crashed.place_order("bob", "ACME", Side.SELL, 100, 100_00)
    winner = crashed.session.get(
        type(crashed.get_account("alice")), trades[0].buyer_account_id
    )
    print(f"  filled against: {winner.name}  "
          f"(alice bid first, so she is still first in line)")
