import { useEffect, useState } from "react";
import { api } from "../api";
import { Donut } from "../components/Donut";
import { PriceChart, type Point } from "../components/PriceChart";
import { Sparkline } from "../components/Sparkline";
import { money, pct, signed, tone } from "../format";
import { stockColor, stockName } from "../symbols";
import type { Candle, Order, Portfolio } from "../types";

const LIVE = new Set(["open", "partially_filled"]);
const STATUS: Record<string, string> = {
  open: "Waiting", partially_filled: "Partly filled", filled: "Filled", cancelled: "Cancelled", expired: "Expired",
};

const when = (t: number) =>
  new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

interface Props {
  account: string;
  symbols: string[];
  portfolio: Portfolio | null;
  orders: Order[];
  onOpen: (symbol: string) => void;
  onCancel: (id: number) => void;
}

export function HomeView({ account, symbols, portfolio: p, orders, onOpen, onCancel }: Props) {
  const [candles, setCandles] = useState<Record<string, Candle[]>>({});
  const [value, setValue] = useState<Point[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all(symbols.map((s) => api.candles(s, 5, 60).then((c) => [s, c] as const)))
        .then((rows) => alive && setCandles(Object.fromEntries(rows)))
        .catch(() => undefined);
      api.valueHistory(account).then((v) => alive && setValue(v)).catch(() => undefined);
    };
    load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [account, symbols]);

  const held = p?.positions.filter((x) => x.quantity > 0) ?? [];

  const gain = (p?.unrealized_pnl?.cents ?? 0) + (p?.realized_pnl?.cents ?? 0);
  const total = p?.total_value?.cents ?? p?.cash.cents ?? 0;
  const base = total - gain;
  const live = orders.filter((o) => LIVE.has(o.status));
  const past = orders.filter((o) => !LIVE.has(o.status)).slice(0, 8);
  const parts = p ? [
    ...held.map((x) => ({ label: x.symbol, value: x.market_value?.cents ?? 0, color: stockColor(x.symbol) })),
    { label: "Cash", value: p.cash.cents, color: "var(--s-cash)" },
  ] : [];

  return (
    <div className="grid">
      <div className="card span-8 stretch">
        <div className="balance-label">Portfolio value</div>
        <div className="balance num">{p?.total_value ? money(p.total_value.cents) : "—"}</div>
        <span className={`gain-pill num ${tone(gain)}`}>
          {signed(gain)} ({pct(base ? (gain / base) * 100 : 0)})
        </span>
        <span className="muted" style={{ fontSize: 14 }}> all time</span>
        <div style={{ marginTop: 14 }}>
          {value.length ? (
            <PriceChart series={value} height={240} formatTime={when} />
          ) : (
            <div className="chart-empty">Your chart starts with your first trade. Pick a stock below.</div>
          )}
        </div>
        {p && (
          <div className="split">
            <div><span>Cash you can spend</span><b>{money(p.available.cents)}</b></div>
            <div><span>Invested</span><b>{p.positions_value ? money(p.positions_value.cents) : "—"}</b></div>
            <div><span>Held for open orders</span><b>{money(p.reserved.cents)}</b></div>
          </div>
        )}
      </div>

      <div className="card span-4 stretch">
        <h2 className="card-title">Allocation</h2>
        {p && (
          <div className="donut-wrap">
            <Donut parts={parts} label={`${total ? Math.round(((total - p.cash.cents) / total) * 100) : 0}%`} sub="invested" />
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
        )}
      </div>

      {symbols.map((s) => {
        const cs = candles[s] ?? [];
        const first = cs[0]?.close, last = cs[cs.length - 1]?.close;
        const ch = first && last ? ((last - first) / first) * 100 : 0;
        return (
          <div key={s} className="card span-4 stock-card" onClick={() => onOpen(s)}
               role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(s)}>
            <div className="stock-head">
              <span className="sym-dot" style={{ background: stockColor(s) }} />
              <div style={{ flex: 1 }}>
                <span className="stock-name">{s}</span>{" "}
                <span className="stock-sym">{stockName(s)}</span>
              </div>
              <span className={`num ${tone(ch)}`} style={{ fontSize: 14, fontWeight: 600 }}>{pct(ch)}</span>
            </div>
            <div className="stock-price num">{last ? money(last) : "—"}</div>
            <div style={{ marginTop: 10 }}>
              <Sparkline values={cs.map((c) => c.close)} color={stockColor(s)} />
            </div>
          </div>
        );
      })}

      {held.length > 0 && (
        <div className="card span-12">
          <h2 className="card-title">Your stocks</h2>
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
        </div>
      )}

      {live.length > 0 && (
        <div className={`card ${past.length ? "span-6" : "span-12"} stretch`}>
          <h2 className="card-title">Open orders</h2>
          <OrderTable orders={live} onCancel={onCancel} />
        </div>
      )}

      {past.length > 0 && (
        <div className={`card ${live.length ? "span-6" : "span-12"} stretch`}>
          <h2 className="card-title">History</h2>
          <OrderTable orders={past} />
        </div>
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
