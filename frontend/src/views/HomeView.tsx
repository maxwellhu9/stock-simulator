import { useEffect, useState } from "react";
import { api } from "../api";
import { PriceChart, type Point } from "../components/PriceChart";
import { Sparkline } from "../components/Sparkline";
import { money, pct, signed, tone } from "../format";
import { stockColor, stockName } from "../symbols";
import type { Candle, MarketEvent, Order, Portfolio } from "../types";

interface Props {
  account: string;
  symbols: string[];
  portfolio: Portfolio | null;
  orders: Order[];
  events: MarketEvent[];
  onOpen: (symbol: string) => void;
}

function ago(t: number) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export function HomeView({ symbols, portfolio, orders, events, onOpen }: Props) {
  const [candles, setCandles] = useState<Record<string, Candle[]>>({});

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all(symbols.map((s) => api.candles(s, 5, 60).then((c) => [s, c] as const)))
        .then((rows) => alive && setCandles(Object.fromEntries(rows)))
        .catch(() => undefined);
    load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbols]);

  // What today's holdings were worth over the last five minutes: cash plus
  // each position at that moment's price.
  const held = portfolio?.positions.filter((p) => p.quantity > 0) ?? [];
  const times = [...new Set(Object.values(candles).flat().map((c) => c.t))].sort((a, b) => a - b);
  const lastClose: Record<string, number> = {};
  const series: Point[] = [];
  if (portfolio) {
    for (const t of times) {
      for (const s of symbols) {
        const c = candles[s]?.find((x) => x.t === t);
        if (c) lastClose[s] = c.close;
      }
      if (held.every((p) => lastClose[p.symbol] !== undefined)) {
        const value = portfolio.cash.cents + held.reduce((n, p) => n + p.quantity * lastClose[p.symbol], 0);
        series.push({ t, v: value });
      }
    }
  }

  const gain = (portfolio?.unrealized_pnl?.cents ?? 0) + (portfolio?.realized_pnl?.cents ?? 0);
  const base = (portfolio?.total_value?.cents ?? 0) - gain;
  const news = events.filter((e) => e.kind !== "scenario").slice(0, 6);
  const recent = orders.slice(0, 6);

  return (
    <>
      <div className="grid">
        <div className="card span-8 stretch">
          <div className="balance-label">Portfolio value</div>
          <div className="balance num">{portfolio?.total_value ? money(portfolio.total_value.cents) : "—"}</div>
          <span className={`gain-pill num ${tone(gain)}`}>
            {signed(gain)} ({pct(base ? (gain / base) * 100 : 0)})
          </span>
          <span className="muted" style={{ fontSize: 14 }}> all time</span>
          <div style={{ marginTop: 14 }}>
            <PriceChart series={series} height={270} />
          </div>
          <div className="note muted num" style={{ fontSize: 13 }}>
            Cash {portfolio ? money(portfolio.available.cents) : "—"} · Invested{" "}
            {portfolio?.positions_value ? money(portfolio.positions_value.cents) : "—"} · Past 5 minutes
          </div>
        </div>

        <div className="card span-4 stretch">
          <h2 className="card-title">News <span className="muted">simulated</span></h2>
          {news.length === 0 ? (
            <p className="empty">Quiet so far. Headlines show up here as they happen.</p>
          ) : (
            <ul className="list">
              {news.map((e, i) => (
                <li key={i} style={{ cursor: e.symbol ? "pointer" : "default" }}
                    onClick={() => e.symbol && onOpen(e.symbol)}>
                  <span className="news-dot" style={{ background: e.kind === "good" ? "var(--up)" : "var(--down)" }} />
                  <div className="grow">
                    <div><b>{e.symbol}</b> {e.headline}</div>
                    <div className="sub">{ago(e.t)}</div>
                  </div>
                  <span className={`num ${tone(e.impact_pct)}`} style={{ fontWeight: 700, fontSize: 13 }}>
                    {pct(e.impact_pct, 1)}
                  </span>
                </li>
              ))}
            </ul>
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

        <div className="card span-6 stretch">
          <h2 className="card-title">Your stocks</h2>
          {held.length === 0 ? (
            <p className="empty">Nothing yet. Pick a stock above to buy your first shares.</p>
          ) : (
            <ul className="list">
              {held.map((p) => (
                <li key={p.symbol} style={{ cursor: "pointer" }} onClick={() => onOpen(p.symbol)}>
                  <span className="sym-dot" style={{ background: stockColor(p.symbol) }} />
                  <div className="grow">
                    <div style={{ fontWeight: 700 }}>{stockName(p.symbol)}</div>
                    <div className="sub">{p.quantity} shares</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="num" style={{ fontWeight: 700 }}>{p.market_value ? money(p.market_value.cents) : "—"}</div>
                    <div className={`num ${tone(p.unrealized_pnl?.cents ?? 0)}`} style={{ fontSize: 12, fontWeight: 600 }}>
                      {p.unrealized_pnl ? signed(p.unrealized_pnl.cents) : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card span-6 stretch">
          <h2 className="card-title">Recent activity</h2>
          {recent.length === 0 ? (
            <p className="empty">Your orders will show up here.</p>
          ) : (
            <ul className="list">
              {recent.map((o) => (
                <li key={o.id}>
                  <span className={o.side === "buy" ? "up" : "down"} style={{ fontWeight: 700, width: 34 }}>
                    {o.side === "buy" ? "Buy" : "Sell"}
                  </span>
                  <div className="grow">
                    <div><b>{o.symbol}</b> · {o.quantity} shares</div>
                    <div className="sub">{o.limit_price ? `Limit ${money(o.limit_price.cents)}` : "Market order"}</div>
                  </div>
                  <span className="pill">{o.status === "filled" ? "Filled" : o.status === "open" ? "Waiting"
                    : o.status === "partially_filled" ? "Partly filled" : o.status === "cancelled" ? "Cancelled" : "Expired"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
