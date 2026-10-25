import { money } from "../format";
import type { Book } from "../types";

/** Asks above, bids below, depth bars behind the numbers. */
export function OrderBook({ book, levels = 6 }: { book: Book | null; levels?: number }) {
  if (!book || (!book.bids.length && !book.asks.length)) {
    return <p className="empty">Empty.</p>;
  }
  const asks = book.asks.slice(0, levels);
  const bids = book.bids.slice(0, levels);
  const max = Math.max(1, ...bids.map((l) => l.quantity), ...asks.map((l) => l.quantity));
  const row = (l: Book["bids"][number], side: "bid" | "ask") => (
    <tr key={side + l.price.cents}>
      <td><span className={`px ${side === "bid" ? "up" : "down"}`}>{money(l.price.cents)}</span></td>
      <td>
        <div className="bar" style={{
          width: `${(l.quantity / max) * 70}%`,
          background: side === "bid" ? "var(--up-soft)" : "var(--down-soft)",
        }} />
        <span className="px">{l.quantity.toLocaleString()}</span>
      </td>
    </tr>
  );
  return (
    <table className="book">
      <tbody>
        {[...asks].reverse().map((l) => row(l, "ask"))}
        <tr className="spread"><td>Spread</td><td>{book.spread ? money(book.spread.cents) : "—"}</td></tr>
        {bids.map((l) => row(l, "bid"))}
      </tbody>
    </table>
  );
}
