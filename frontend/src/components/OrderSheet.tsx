import { useState } from "react";
import { ApiError, api } from "../api";
import { money, who } from "../format";
import type { Book, PlaceOrderResult, Portfolio, Side } from "../types";

interface Props {
  account: string;
  symbol: string;
  initialSide: Side;
  book: Book | null;
  portfolio: Portfolio | null;
  onClose: () => void;
  onPlaced: () => void;
}

const PRICE_RE = /^\d+(\.\d{1,2})?$/;

export function OrderSheet({
  account, symbol, initialSide, book, portfolio, onClose, onPlaced,
}: Props) {
  const [side, setSide] = useState<Side>(initialSide);
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [shares, setShares] = useState("10");
  const [limit, setLimit] = useState(
    () => (initialSide === "buy" ? book?.best_bid : book?.best_ask)?.display.replace(/,/g, "") ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaceOrderResult | null>(null);

  const qty = Number(shares);
  const qtyOk = Number.isInteger(qty) && qty > 0;
  const priceOk = kind === "market" || PRICE_RE.test(limit);
  const buying = side === "buy";

  const held = portfolio?.positions.find((p) => p.symbol === symbol);
  const reference = buying ? book?.best_ask : book?.best_bid;
  const unitCents = kind === "limit" && priceOk
    ? Math.round(Number(limit) * 100)
    : (reference?.cents ?? null);
  const total = qtyOk && unitCents !== null ? unitCents * qty : null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.placeOrder({
        account, symbol, side, quantity: qty,
        limit_price: kind === "limit" ? limit : null,
      });
      setResult(r);
      onPlaced();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label={`${side} ${symbol}`}>
        {result ? (
          <Outcome result={result} side={side} me={account} onClose={onClose} />
        ) : (
          <>
            <h2>{buying ? "Buy" : "Sell"} {symbol}</h2>
            <p className="sub note">
              {buying
                ? `You have ${portfolio ? money(portfolio.available.cents) : "—"} to spend.`
                : `You own ${held?.available ?? 0} ${symbol} you can sell.`}
            </p>

            <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
              <div className="seg">
                <button className={buying ? "on" : ""} onClick={() => setSide("buy")}>Buy</button>
                <button className={!buying ? "on" : ""} onClick={() => setSide("sell")}>Sell</button>
              </div>
              <div className="seg">
                <button className={kind === "market" ? "on" : ""} onClick={() => setKind("market")}>Market</button>
                <button className={kind === "limit" ? "on" : ""} onClick={() => setKind("limit")}>Limit</button>
              </div>
            </div>

            <label className="field">
              <span>Shares</span>
              <input className="input" value={shares} inputMode="numeric" autoFocus
                     onChange={(e) => setShares(e.target.value)} />
            </label>

            {kind === "limit" && (
              <label className="field">
                <span>{buying ? "Highest price you'll pay" : "Lowest price you'll accept"}</span>
                <input className="input" value={limit} inputMode="decimal"
                       onChange={(e) => setLimit(e.target.value)} />
              </label>
            )}

            {kind === "market" && (
              <div className="line">
                <span className="soft">{buying ? "Cheapest seller" : "Best buyer"}</span>
                <span className="num">{reference ? money(reference.cents) : "—"}</span>
              </div>
            )}
            <div className="line" style={{ fontWeight: 600 }}>
              <span>Estimated total</span>
              <span className="num">{total !== null ? money(total) : "—"}</span>
            </div>
            {kind === "market" && (
              <p className="note muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
                A large order may fill at a few different prices.
              </p>
            )}

            {error && <div className="err" style={{ marginTop: 16 }}>{error}</div>}
            <button className={`btn ${buying ? "btn-buy" : "btn-sell"}`}
                    disabled={!qtyOk || !priceOk || busy} onClick={submit}>
              {busy ? "Placing…" : `${buying ? "Buy" : "Sell"} ${qtyOk ? qty : ""} ${symbol}`}
            </button>
            <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
          </>
        )}
      </div>
    </div>
  );
}

/** What happened, said plainly. */
function Outcome({ result, side, me, onClose }: {
  result: PlaceOrderResult; side: Side; me: string; onClose: () => void;
}) {
  const { order, trades } = result;
  const buying = side === "buy";
  const filled = trades.reduce((n, t) => n + t.quantity, 0);
  const remaining = order.quantity - filled;
  const cost = trades.reduce((n, t) => n + t.price.cents * t.quantity, 0);
  const avg = filled ? Math.round(cost / filled) : 0;

  let headline: string;
  let explain: string;

  if (filled === 0) {
    headline = order.limit_price ? `Waiting at ${money(order.limit_price.cents)}` : "Nothing to trade with";
    explain = order.limit_price
      ? `Nobody is ${buying ? "selling" : "buying"} at that price right now. Your order sits on the book until someone is, or until you cancel it from Portfolio.`
      : `There was no one on the other side to trade with.`;
  } else {
    headline = `${buying ? "Bought" : "Sold"} ${filled} at ${money(avg)}`;
    const others = trades.map((t) => (buying ? t.seller : t.buyer));
    if (trades.length === 1) {
      explain = `${who(others[0], me)} was ${buying ? "selling" : "buying"} at that price, so you traded with them.`;
    } else {
      const prices = trades.map((t) => t.price.cents);
      explain = `It took ${trades.length} ${buying ? "sellers" : "buyers"} to fill, from ${money(Math.min(...prices))} to ${money(Math.max(...prices))}. Each one gave you the best price left at the time.`;
    }
    if (remaining > 0) {
      explain += order.limit_price
        ? ` The other ${remaining} are waiting on the book at ${money(order.limit_price.cents)}.`
        : ` The other ${remaining} found no one to trade with.`;
    }
  }

  return (
    <>
      <p className="note muted" style={{ margin: 0 }}>{buying ? "Buy" : "Sell"} {order.symbol}</p>
      <div className="result-big num">{headline}</div>
      <p className="note" style={{ margin: "0 0 18px" }}>{explain}</p>
      <button className="btn btn-ink" onClick={onClose}>Done</button>
    </>
  );
}
