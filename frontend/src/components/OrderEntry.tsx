import { useState } from "react";
import type { Book, Side } from "../types";

interface Props {
  account: string | null;
  symbol: string;
  book: Book | null;
  onSubmit: (o: {
    side: Side;
    quantity: number;
    limit_price: string | null;
  }) => Promise<void>;
  busy: boolean;
}

export function OrderEntry({ account, symbol, book, onSubmit, busy }: Props) {
  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<"limit" | "market">("limit");
  const [quantity, setQuantity] = useState("100");
  const [price, setPrice] = useState("100.00");

  const qty = Number(quantity);
  const valid =
    account !== null &&
    Number.isInteger(qty) &&
    qty > 0 &&
    (type === "market" || /^\d+(\.\d{1,2})?$/.test(price));

  // Estimated cost, computed in integer cents to match the backend exactly.
  const estCents =
    type === "limit" && valid ? Math.round(Number(price) * 100) * qty : null;

  return (
    <div className="panel">
      <h2>New order · {symbol}</h2>
      <div className="body">
        <div className="sidetabs">
          <button
            className={side === "buy" ? "on-buy" : ""}
            onClick={() => setSide("buy")}
          >
            Buy
          </button>
          <button
            className={side === "sell" ? "on-sell" : ""}
            onClick={() => setSide("sell")}
          >
            Sell
          </button>
        </div>

        <div className="field">
          <label>Order type</label>
          <select value={type} onChange={(e) => setType(e.target.value as never)}>
            <option value="limit">Limit — name your price, wait</option>
            <option value="market">Market — any price, right now</option>
          </select>
        </div>

        <div className="row">
          <div className="field">
            <label>Quantity</label>
            <input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputMode="numeric"
            />
          </div>
          {type === "limit" && (
            <div className="field">
              <label>Limit price</label>
              {/* Sent as a string, never a JSON number -- the backend rejects
                  floats so precision cannot be lost in transit. */}
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
              />
            </div>
          )}
        </div>

        {estCents !== null && (
          <div className="stat" style={{ marginBottom: 10 }}>
            <span>{side === "buy" ? "cost if filled" : "proceeds if filled"}</span>
            <span className="mono">
              {(estCents / 100).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
        )}
        {type === "market" && (
          <div className="stat" style={{ marginBottom: 10 }}>
            <span>best {side === "buy" ? "ask" : "bid"}</span>
            <span className="mono">
              {side === "buy"
                ? (book?.best_ask?.display ?? "—")
                : (book?.best_bid?.display ?? "—")}
            </span>
          </div>
        )}

        <button
          className={`submit ${side}`}
          disabled={!valid || busy}
          onClick={() =>
            onSubmit({
              side,
              quantity: qty,
              limit_price: type === "market" ? null : price,
            })
          }
        >
          {busy ? "working…" : `${side === "buy" ? "Buy" : "Sell"} ${qty || 0} ${symbol}`}
        </button>
      </div>
    </div>
  );
}
