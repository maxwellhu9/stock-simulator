"""Watch the order book fill up, then get hit."""

from app.money import dollars, format_cents
from app.orderbook import OrderBook, Side


def show(book: OrderBook, title: str) -> None:
    print(f"\n  {title}")
    print(f"  {'-' * 46}")
    print(f"  {'BIDS (buyers)':>22}   {'ASKS (sellers)':<22}")
    bids, asks = book.depth(Side.BUY), book.depth(Side.SELL)
    for i in range(max(len(bids), len(asks), 1)):
        left = f"{bids[i][1]:>6} @ {format_cents(bids[i][0]):>7}" if i < len(bids) else " " * 16
        right = f"{format_cents(asks[i][0]):<7} @ {asks[i][1]:<6}" if i < len(asks) else ""
        print(f"  {left:>22}   {right:<22}")
    sp = book.spread
    print(f"  {'-' * 46}")
    bb = "--" if book.best_bid is None else format_cents(book.best_bid)
    ba = "--" if book.best_ask is None else format_cents(book.best_ask)
    print(f"  best bid {bb}   best ask {ba}   "
          f"spread {'--' if sp is None else format_cents(sp)}")


book = OrderBook("ACME")

print("\nSeven traders post orders. Nobody crosses, so nothing trades yet.")
book.submit("alice", Side.BUY, 200, price=9950)
book.submit("bob", Side.BUY, 150, price=9950)   # same price, later -> behind alice
book.submit("carol", Side.BUY, 300, price=9925)
book.submit("dave", Side.BUY, 500, price=9900)
book.submit("erin", Side.SELL, 100, price=10000)
book.submit("frank", Side.SELL, 250, price=10025)
book.submit("gina", Side.SELL, 400, price=10050)
show(book, "THE BOOK")

print("\n\nNow HANK sends a market order: BUY 600, any price.")
order, trades = book.submit("hank", Side.BUY, 600, price=None)

print(f"\n  {'filled':>8}  {'at price':>9}  {'from':>7}")
print(f"  {'-'*8}  {'-'*9}  {'-'*7}")
for t in trades:
    print(f"  {t.quantity:>8}  {format_cents(t.price):>9}  {t.seller_id:>7}")
total = sum(t.price * t.quantity for t in trades)
avg = total / sum(t.quantity for t in trades)
print(f"\n  Hank bought {order.filled} for {dollars(total)}, "
      f"averaging {format_cents(round(avg))} per share.")
print(f"  He walked UP the book: cheapest seller first, then the next.")
print(f"  {order.remaining} shares went unfilled and were abandoned "
      f"(market orders never rest).")
show(book, "THE BOOK AFTER")

print("\n\nNow IVY posts a limit: SELL 250 at 99.50 -- crossing into the bids.")
order, trades = book.submit("ivy", Side.SELL, 250, price=9950)
print(f"\n  {'filled':>8}  {'at price':>9}  {'to':>7}")
print(f"  {'-'*8}  {'-'*9}  {'-'*7}")
for t in trades:
    print(f"  {t.quantity:>8}  {format_cents(t.price):>9}  {t.buyer_id:>7}")
print(f"\n  Alice filled before Bob at the same price -- she was there first.")
