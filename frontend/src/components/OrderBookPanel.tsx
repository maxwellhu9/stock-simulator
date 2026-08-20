import type { Book, Level } from "../types";

/** Asks descend from the top, bids ascend from the spread -- the conventional
 *  ladder, so the best prices from both sides meet in the middle. */
export function OrderBookPanel({ book }: { book: Book | null }) {
  if (!book) return <div className="panel"><h2>Order book</h2><div className="empty">loading…</div></div>;

  const maxQty = Math.max(
    1,
    ...book.bids.map((l) => l.quantity),
    ...book.asks.map((l) => l.quantity),
  );

  const row = (l: Level, side: "bid" | "ask") => (
    <tr className="level" key={`${side}-${l.price.cents}`}>
      <td>
        <div
          className={`bar ${side}-bar`}
          style={{ width: `${(l.quantity / maxQty) * 100}%` }}
        />
        <span className={`mono ${side}-px`}>{l.price.display}</span>
      </td>
      <td className="mono" style={{ textAlign: "right" }}>{l.quantity}</td>
    </tr>
  );

  return (
    <div className="panel">
      <h2>Order book · {book.symbol}</h2>
      <table>
        <thead>
          <tr><th>Price</th><th>Size</th></tr>
        </thead>
        <tbody>
          {/* highest ask at the top, walking down toward the spread */}
          {[...book.asks].reverse().map((l) => row(l, "ask"))}
        </tbody>
      </table>

      <div className="spread-row">
        <span>spread</span>
        <span className="mono">{book.spread ? book.spread.display : "—"}</span>
      </div>

      <table>
        <tbody>{book.bids.map((l) => row(l, "bid"))}</tbody>
      </table>
      {book.bids.length === 0 && book.asks.length === 0 && (
        <div className="empty">no resting orders</div>
      )}
    </div>
  );
}
