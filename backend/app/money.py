"""Money is stored as integer cents. Never as a float.

Binary floating point cannot represent 0.10 exactly, so 0.1 + 0.2 comes out as
0.30000000000000004. In a system whose whole job is moving money between
accounts, those errors accumulate until balances stop reconciling -- and the bug
surfaces as "we are three cents short" weeks later, with no way to trace it.

Exchanges solve this by never using fractions at all: every amount is a whole
number of the smallest unit. $99.50 is the integer 9950. Addition and
subtraction are then exact by construction.

Conversion from human input goes through Decimal, never through float, because
float("99.50") has already lost the precision before you can round it.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CENTS_PER_DOLLAR = 100


def to_cents(amount: str | int | Decimal) -> int:
    """Parse a human-entered amount into integer cents.

    Accepts "99.50", Decimal("99.50"), or a whole number of dollars. Rejects
    floats outright -- by the time a float reaches this function the precision
    is already gone, so accepting one would only hide the problem.
    """
    if isinstance(amount, float):
        raise TypeError(
            "refusing to convert a float to money; pass a string like '99.50' "
            "or a Decimal so no precision is lost before we get here"
        )
    try:
        d = Decimal(amount) if not isinstance(amount, Decimal) else amount
    except InvalidOperation as exc:
        raise ValueError(f"not a valid money amount: {amount!r}") from exc

    cents = (d * CENTS_PER_DOLLAR).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(cents)


def format_cents(cents: int) -> str:
    """Render integer cents for display: 9950 -> '99.50'."""
    sign = "-" if cents < 0 else ""
    whole, frac = divmod(abs(cents), CENTS_PER_DOLLAR)
    return f"{sign}{whole:,}.{frac:02d}"


def dollars(cents: int) -> str:
    """Same as format_cents, with a currency symbol."""
    sign = "-" if cents < 0 else ""
    return f"{sign}${format_cents(abs(cents))}"
