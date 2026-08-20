"""A simulated market maker, seeded from real prices.

This is the "hybrid" half of the design. A pure exchange has a real matching
engine but nothing to trade against when you are the only user. A pure brokerage
always fills you but has no matching engine worth writing. So: keep the real
engine, and add a participant who is always quoting.

Prices start from a real last-traded price pulled once at startup, then random
walk from there. Deliberately not live-streamed -- markets close, APIs rate
limit, and a demo that only works on a weekday afternoon is not a demo.

What it does each tick:
  1. pull its previous quotes off the book
  2. nudge the mid price
  3. post fresh two-sided quotes around the new mid

Anything it got filled on in between is simply gone from the book already, which
is exactly what happens to a real market maker.
"""

from __future__ import annotations

import math
import random

from sqlmodel import Session

from .exchange import Exchange, ExchangeError
from .orderbook import OrderBook, Side

MM_ACCOUNT = "market_maker"

# Last-resort prices, in cents, if the network is unavailable at startup. Real
# values are fetched once and overwrite these.
FALLBACK_PRICES: dict[str, int] = {
    "AAPL": 23150,
    "NVDA": 18420,
    "MSFT": 51075,
}

TICK_VOL = 0.0015      # per-tick price move, chosen to be visible in a demo
HALF_SPREAD = 0.0004   # quoted spread as a fraction of mid
LEVELS = 4             # price levels quoted on each side
STEP = 0.0005          # gap between levels, as a fraction of mid


def fetch_real_prices(symbols: list[str]) -> dict[str, int]:
    """One-shot real prices. Falls back silently -- this must never block startup."""
    prices = dict(FALLBACK_PRICES)
    try:
        import yfinance as yf

        for sym in symbols:
            try:
                last = float(yf.Ticker(sym).fast_info.last_price)
                if last > 0:
                    prices[sym] = int(round(last * 100))
            except Exception:
                continue
    except Exception:
        pass
    return {s: prices.get(s, 10000) for s in symbols}


class MarketMaker:
    def __init__(self, books: dict[str, OrderBook], mids: dict[str, int]) -> None:
        self.books = books
        self.mids = dict(mids)
        self._quotes: dict[str, list[int]] = {s: [] for s in mids}

    def ensure_account(self, session: Session) -> None:
        """The maker needs deep enough inventory that it never runs dry."""
        ex = Exchange(session, books=self.books)
        try:
            account = ex.get_account(MM_ACCOUNT)
        except ExchangeError:
            account = ex.open_account(MM_ACCOUNT, 100_000_000_00)

        if account.available_cents < 10_000_000_00:
            account.cash_cents += 100_000_000_00
        for symbol in self.mids:
            pos = ex.position(account.id, symbol)
            if pos.available_quantity < 20_000:
                pos.quantity += 100_000
        session.commit()

    def tick(self, session: Session, symbol: str) -> None:
        ex = Exchange(session, books=self.books)

        for order_id in self._quotes.get(symbol, []):
            try:
                ex.cancel_order(order_id)
            except ExchangeError:
                pass  # already filled or already gone; nothing to pull

        # Geometric random walk, so the price can never go negative.
        mid = self.mids[symbol]
        mid = max(100, int(round(mid * math.exp(random.gauss(0, TICK_VOL)))))
        self.mids[symbol] = mid

        half = max(1, int(round(mid * HALF_SPREAD)))
        step = max(1, int(round(mid * STEP)))

        fresh: list[int] = []
        for i in range(LEVELS):
            size = random.randint(40, 260)
            bid = mid - half - i * step
            ask = mid + half + i * step
            for side, price in ((Side.BUY, bid), (Side.SELL, ask)):
                try:
                    order, _ = ex.place_order(MM_ACCOUNT, symbol, side, size, price)
                    fresh.append(order.id)
                except ExchangeError:
                    continue
        self._quotes[symbol] = fresh
