"""Two traders, real accounts, real money. Watch the balances move."""

from sqlmodel import Session, SQLModel, create_engine

from app.exchange import Exchange, InsufficientFunds, InsufficientShares
from app.money import dollars
from app.orderbook import Side

engine = create_engine("postgresql+psycopg://localhost:5432/paper_exchange")
SQLModel.metadata.drop_all(engine)
SQLModel.metadata.create_all(engine)


def show(ex, *names):
    print(f"\n  {'account':<8} {'cash':>13} {'reserved':>12} {'available':>13}  positions")
    print(f"  {'-'*8} {'-'*13} {'-'*12} {'-'*13}  {'-'*22}")
    for n in names:
        p = ex.portfolio(n)
        pos = ", ".join(f"{q['quantity']} {q['symbol']}"
                        + (f" ({q['reserved']} held)" if q["reserved"] else "")
                        for q in p["positions"]) or "--"
        print(f"  {p['name']:<8} {dollars(p['cash_cents']):>13} "
              f"{dollars(p['reserved_cents']):>12} "
              f"{dollars(p['available_cents']):>13}  {pos}")


with Session(engine) as session:
    ex = Exchange(session)

    ex.open_account("alice", 50_000_00)
    ex.open_account("bob", 10_000_00)
    ex.position(ex.get_account("bob").id, "ACME").quantity = 500
    session.commit()

    print("\nSTART — alice has cash, bob has 500 shares.")
    show(ex, "alice", "bob")

    print("\n\n1. Alice bids for 100 shares at $100. Nobody is selling yet.")
    order, trades = ex.place_order("alice", "ACME", Side.BUY, 100, 100_00)
    print(f"   {len(trades)} trades. Her $10,000 is now RESERVED — not spent,")
    print("   but no longer available to commit elsewhere.")
    show(ex, "alice", "bob")

    print("\n\n2. Alice tries to bid for another 500 shares at $100.")
    try:
        ex.place_order("alice", "ACME", Side.BUY, 500, 100_00)
    except InsufficientFunds as e:
        print(f"   REJECTED: {e}")

    print("\n\n3. Bob tries to sell 900 shares. He only has 500.")
    try:
        ex.place_order("bob", "ACME", Side.SELL, 900, 100_00)
    except InsufficientShares as e:
        print(f"   REJECTED: {e}")

    print("\n\n4. Bob sells 100 at $99. Alice is already resting at $100, so they cross.")
    order, trades = ex.place_order("bob", "ACME", Side.SELL, 100, 99_00)
    for t in trades:
        print(f"   FILLED {t.quantity} @ {dollars(t.price_cents)} "
              f"= {dollars(t.notional_cents)}")
    print("   Note the fill price: $100, ALICE's price, not Bob's $99.")
    print("   Alice was resting on the book, so she gets exactly what she asked for.")
    print("   Bob crossed the spread, so the improvement goes to him: he offered")
    print("   to take $99 and received $100 — an extra $100 on the trade.")
    show(ex, "alice", "bob")

    total = (ex.portfolio("alice")["cash_cents"] + ex.portfolio("bob")["cash_cents"])
    shares = sum(q["quantity"] for n in ("alice", "bob")
                 for q in ex.portfolio(n)["positions"])
    print(f"\n\n  Cash in the system:   {dollars(total)}  (started at $60,000.00)")
    print(f"  Shares in the system: {shares}  (started at 500)")
    print("  Nothing created, nothing destroyed — only moved.")
