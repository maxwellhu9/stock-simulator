import { useEffect, useState } from "react";
import { api } from "../api";
import { Headline } from "../components/Headline";
import { OrderBook } from "../components/OrderBook";
import { PriceChart, type Point } from "../components/PriceChart";
import { money, pct, signed, tone } from "../format";
import { stockColor, stockName } from "../symbols";
import type { Book, MarketEvent, Money, Portfolio, Side } from "../types";

const RANGES = {
  "1M": { seconds: 2, limit: 30, label: "past minute" },
  "5M": { seconds: 5, limit: 60, label: "past 5 minutes" },
  "15M": { seconds: 15, limit: 60, label: "past 15 minutes" },
  "1H": { seconds: 60, limit: 60, label: "past hour" },
} as const;
type Range = keyof typeof RANGES;

interface Props {
  symbol: string;
  symbols: string[];
  onSymbol: (s: string) => void;
  last: Money | null;
  book: Book | null;
  portfolio: Portfolio | null;
  onTrade: (side: Side) => void;
  events: MarketEvent[];
}

export function StockView({ symbol, symbols, onSymbol, last, book, portfolio, onTrade, events }: Props) {
  const [range, setRange] = useState<Range>("5M");
  const [series, setSeries] = useState<Point[]>([]);
  const [scrub, setScrub] = useState<Point | null>(null);

  useEffect(() => {
    let alive = true;
    const { seconds, limit } = RANGES[range];
    const load = () =>
      api.candles(symbol, seconds, limit)
        .then((cs) => alive && setSeries(cs.map((c) => ({ t: c.t, v: c.close }))))
        .catch(() => undefined);
    setSeries([]);
    load();
    const id = setInterval(load, range === "1M" ? 2000 : 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol, range]);

  const line = last && series.length
    ? [...series, { t: Math.max(Date.now() / 1000, series[series.length - 1].t + 1), v: last.cents }]
    : series;
  const start = line[0]?.v;
  const shown = scrub?.v ?? last?.cents ?? line[line.length - 1]?.v;
  const delta = start !== undefined && shown !== undefined ? shown - start : 0;

  const held = portfolio?.positions.find((p) => p.symbol === symbol);
  const news = events.filter((e) => e.symbol === symbol && e.kind !== "scenario");
  const fresh = news.find((e) => Date.now() / 1000 - e.t < 120);

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="sym-dot" style={{ background: stockColor(symbol), width: 12, height: 12 }} />
          <h1>{stockName(symbol)} <span className="muted" style={{ fontWeight: 500 }}>{symbol}</span></h1>
        </div>
        <div className="symbols">
          {symbols.map((s) => (
            <button key={s} className={`chip ${s === symbol ? "on" : ""}`} onClick={() => onSymbol(s)}>
              <i style={{ background: stockColor(s) }} />{s}
            </button>
          ))}
        </div>
      </div>

      <div className="grid">
        <div className="card span-8">
          <div className="price-big num">{shown !== undefined ? money(shown) : "—"}</div>
          <div className={`change num ${tone(delta)}`}>
            {start !== undefined && shown !== undefined && (
              <>
                {delta >= 0 ? "▲" : "▼"} {signed(delta).replace(/^[+−]/, "")} ({pct((delta / start) * 100)})
                <span className="muted" style={{ fontWeight: 500 }}>
                  {" "}{scrub ? new Date(scrub.t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : RANGES[range].label}
                </span>
              </>
            )}
          </div>
          {fresh && <div style={{ marginTop: 16 }}><Headline event={fresh} /></div>}
          <div className="chart-wrap">
            <PriceChart series={line} baseline={start} onScrub={setScrub} height={360}
                        markers={news.map((e) => ({ t: e.t, tone: e.kind === "good" ? "up" : "down" }))} />
          </div>
          <div className="ranges">
            <div className="seg">
              {(Object.keys(RANGES) as Range[]).map((r) => (
                <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>{r}</button>
              ))}
            </div>
            {book?.best_bid && book.best_ask && (
              <span className="note muted num" style={{ fontSize: 13 }}>
                {money(book.best_bid.cents)} bid · {money(book.best_ask.cents)} ask
              </span>
            )}
          </div>
          <div className="actions">
            <button className="btn btn-buy" onClick={() => onTrade("buy")}>Buy {symbol}</button>
            <button className="btn btn-sell" onClick={() => onTrade("sell")}>Sell {symbol}</button>
          </div>
        </div>

        <div className="span-4" style={{ display: "grid", gap: 20 }}>
          <div className="card">
            <h2 className="card-title">Your position</h2>
            {held && held.quantity > 0 ? (
              <>
                <div className="kv"><span>Shares</span><b>{held.quantity}</b></div>
                <div className="kv"><span>Worth</span><b>{held.market_value ? money(held.market_value.cents) : "—"}</b></div>
                <div className="kv"><span>Paid on average</span><b>{held.avg_cost ? money(held.avg_cost.cents) : "—"}</b></div>
                <div className="kv">
                  <span>Gain</span>
                  <b className={tone(held.unrealized_pnl?.cents ?? 0)}>
                    {held.unrealized_pnl ? signed(held.unrealized_pnl.cents) : "—"}
                  </b>
                </div>
              </>
            ) : (
              <p className="empty">You don't own any {symbol} yet.</p>
            )}
          </div>

          <div className="card">
            <h2 className="card-title">Order book</h2>
            <OrderBook book={book} levels={5} />
          </div>

          <div className="card">
            <h2 className="card-title">{symbol} news</h2>
            {news.length === 0 ? (
              <p className="empty">No headlines yet.</p>
            ) : (
              <ul className="list">
                {news.slice(0, 4).map((e, i) => (
                  <li key={i}>
                    <span className="news-dot" style={{ background: e.kind === "good" ? "var(--up)" : "var(--down)" }} />
                    <div className="grow">{e.headline}</div>
                    <span className={`num ${tone(e.impact_pct)}`} style={{ fontWeight: 700, fontSize: 13 }}>{pct(e.impact_pct, 1)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
