import { money, signed, tone } from "../format";
import type { Order, Portfolio } from "../types";

const LIVE = new Set(["open", "partially_filled"]);
const STATUS: Record<string, string> = {
  open: "Waiting",
  partially_filled: "Partly filled",
  filled: "Filled",
  cancelled: "Cancelled",
  expired: "Expired",
};

interface Props {
  portfolio: Portfolio | null;
  orders: Order[];
  onCancel: (id: number) => void;
}

export function PortfolioView({ portfolio: p, orders, onCancel }: Props) {
  if (!p) return <div className="portfolio"><p className="empty">Loading…</p></div>;

  const gain = (p.unrealized_pnl?.cents ?? 0) + (p.realized_pnl?.cents ?? 0);
  const held = p.positions.filter((x) => x.quantity > 0);
  const live = orders.filter((o) => LIVE.has(o.status));
  const past = orders.filter((o) => !LIVE.has(o.status)).slice(0, 15);

  return (
    <div className="portfolio">
      <p className="note muted" style={{ margin: "0 0 6px" }}>Total value</p>
      <div className="price-big num">{p.total_value ? money(p.total_value.cents) : "—"}</div>
      <div className={`change num ${tone(gain)}`}>
        {signed(gain)} <span className="muted" style={{ fontWeight: 400 }}>total gain</span>
      </div>

      <div className="stats">
        <div><span>Cash you can spend</span><b>{money(p.available.cents)}</b></div>
        <div><span>Invested</span><b>{p.positions_value ? money(p.positions_value.cents) : "—"}</b></div>
        <div><span>Held for open orders</span><b>{money(p.reserved.cents)}</b></div>
      </div>

      <h3 className="section-title">Stocks</h3>
      {held.length === 0 ? (
        <p className="empty">You don't own anything yet. Buy something from the Trade tab.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Stock</th><th>Shares</th><th className="wide">Paid (avg)</th><th className="wide">Price</th><th>Value</th><th>Gain</th></tr>
          </thead>
          <tbody>
            {held.map((x) => (
              <tr key={x.symbol}>
                <td><b>{x.symbol}</b></td>
                <td>{x.quantity}</td>
                <td className="wide">{x.avg_cost ? money(x.avg_cost.cents) : "—"}</td>
                <td className="wide">{x.last_price ? money(x.last_price.cents) : "—"}</td>
                <td>{x.market_value ? money(x.market_value.cents) : "—"}</td>
                <td className={tone(x.unrealized_pnl?.cents ?? 0)}>
                  {x.unrealized_pnl ? signed(x.unrealized_pnl.cents) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="section-title">Open orders</h3>
      {live.length === 0 ? (
        <p className="empty">No orders waiting.</p>
      ) : (
        <OrderTable orders={live} onCancel={onCancel} />
      )}

      {past.length > 0 && (
        <>
          <h3 className="section-title">History</h3>
          <OrderTable orders={past} />
        </>
      )}
    </div>
  );
}

function OrderTable({ orders, onCancel }: { orders: Order[]; onCancel?: (id: number) => void }) {
  return (
    <table className="table">
      <thead>
        <tr><th>Order</th><th>Shares</th><th>Price</th><th>Status</th>{onCancel && <th />}</tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td>
              <span className={o.side === "buy" ? "up" : "down"} style={{ fontWeight: 600 }}>
                {o.side === "buy" ? "Buy" : "Sell"}
              </span>{" "}
              {o.symbol}
            </td>
            <td>{o.filled_quantity === o.quantity || o.filled_quantity === 0
              ? o.quantity : `${o.filled_quantity} of ${o.quantity}`}</td>
            <td>{o.limit_price ? money(o.limit_price.cents) : "Market"}</td>
            <td><span className="pill">{STATUS[o.status]}</span></td>
            {onCancel && (
              <td><button className="link" onClick={() => onCancel(o.id)}>Cancel</button></td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
