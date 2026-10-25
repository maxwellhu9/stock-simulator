import { Donut } from "../components/Donut";
import { money, pct, signed, tone } from "../format";
import { stockColor, stockName } from "../symbols";
import type { Order, Portfolio } from "../types";

const LIVE = new Set(["open", "partially_filled"]);
const STATUS: Record<string, string> = {
  open: "Waiting", partially_filled: "Partly filled", filled: "Filled", cancelled: "Cancelled", expired: "Expired",
};

interface Props {
  portfolio: Portfolio | null;
  orders: Order[];
  onCancel: (id: number) => void;
  onOpen: (symbol: string) => void;
}

export function PortfolioView({ portfolio: p, orders, onCancel, onOpen }: Props) {
  if (!p) return <p className="empty">Loading…</p>;

  const gain = (p.unrealized_pnl?.cents ?? 0) + (p.realized_pnl?.cents ?? 0);
  const held = p.positions.filter((x) => x.quantity > 0);
  const live = orders.filter((o) => LIVE.has(o.status));
  const past = orders.filter((o) => !LIVE.has(o.status)).slice(0, 10);
  const total = p.total_value?.cents ?? p.cash.cents;
  const parts = [
    ...held.map((x) => ({ label: x.symbol, value: x.market_value?.cents ?? 0, color: stockColor(x.symbol) })),
    { label: "Cash", value: p.cash.cents, color: "var(--s-cash)" },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Portfolio</h1>
      </div>

      <div className="grid">
        <div className="card span-7 stretch">
          <div className="balance-label">Total value</div>
          <div className="balance num">{p.total_value ? money(p.total_value.cents) : "—"}</div>
          <span className={`gain-pill num ${tone(gain)}`}>{signed(gain)} ({pct(total - gain ? (gain / (total - gain)) * 100 : 0)})</span>
          <span className="muted" style={{ fontSize: 14 }}> all time</span>
          <div className="split">
            <div><span>Cash you can spend</span><b>{money(p.available.cents)}</b></div>
            <div><span>Invested</span><b>{p.positions_value ? money(p.positions_value.cents) : "—"}</b></div>
            <div><span>Held for open orders</span><b>{money(p.reserved.cents)}</b></div>
          </div>
        </div>

        <div className="card span-5 stretch">
          <h2 className="card-title">Allocation</h2>
          <div className="donut-wrap">
            <Donut parts={parts} label={`${Math.round(((total - p.cash.cents) / total) * 100)}%`} sub="invested" />
            <ul className="legend-list">
              {parts.map((x) => (
                <li key={x.label}>
                  <span className="news-dot" style={{ background: x.color }} />
                  <span className="grow">{x.label}</span>
                  <b className="num">{total ? Math.round((x.value / total) * 100) : 0}%</b>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="card span-12">
          <h2 className="card-title">Stocks</h2>
          {held.length === 0 ? (
            <p className="empty">You don't own anything yet. Open a stock from Home to buy some.</p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Stock</th><th>Shares</th><th className="wide">Paid (avg)</th><th className="wide">Price</th><th>Value</th><th>Gain</th></tr>
              </thead>
              <tbody>
                {held.map((x) => (
                  <tr key={x.symbol} style={{ cursor: "pointer" }} onClick={() => onOpen(x.symbol)}>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                        <span className="sym-dot" style={{ background: stockColor(x.symbol) }} />
                        <b>{x.symbol}</b> <span className="muted">{stockName(x.symbol)}</span>
                      </span>
                    </td>
                    <td>{x.quantity}</td>
                    <td className="wide">{x.avg_cost ? money(x.avg_cost.cents) : "—"}</td>
                    <td className="wide">{x.last_price ? money(x.last_price.cents) : "—"}</td>
                    <td>{x.market_value ? money(x.market_value.cents) : "—"}</td>
                    <td className={tone(x.unrealized_pnl?.cents ?? 0)}>{x.unrealized_pnl ? signed(x.unrealized_pnl.cents) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card span-6 stretch">
          <h2 className="card-title">Open orders</h2>
          {live.length === 0 ? <p className="empty">No orders waiting.</p> : <OrderTable orders={live} onCancel={onCancel} />}
        </div>

        <div className="card span-6 stretch">
          <h2 className="card-title">History</h2>
          {past.length === 0 ? <p className="empty">Nothing yet.</p> : <OrderTable orders={past} />}
        </div>
      </div>
    </>
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
              <span className={o.side === "buy" ? "up" : "down"} style={{ fontWeight: 700 }}>{o.side === "buy" ? "Buy" : "Sell"}</span>{" "}
              {o.symbol}
            </td>
            <td>{o.filled_quantity === o.quantity || o.filled_quantity === 0 ? o.quantity : `${o.filled_quantity}/${o.quantity}`}</td>
            <td>{o.limit_price ? money(o.limit_price.cents) : "Market"}</td>
            <td><span className="pill">{STATUS[o.status]}</span></td>
            {onCancel && <td><button className="link" onClick={() => onCancel(o.id)}>Cancel</button></td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
