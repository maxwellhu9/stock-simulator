import { useEffect, useState } from "react";
import { api } from "../api";
import { PriceChart, type Point } from "../components/PriceChart";
import { money, pct, signed, tone } from "../format";
import type { Book, Money, Portfolio, Side } from "../types";

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
}

export function TradeView({ symbol, symbols, onSymbol, last, book, portfolio, onTrade }: Props) {
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

  // Keep the tip of the line live between candle refreshes.
  const line = last && series.length
    ? [...series, { t: Math.max(Date.now() / 1000, series[series.length - 1].t + 1), v: last.cents }]
    : series;

  const start = line[0]?.v;
  const shown = scrub?.v ?? last?.cents ?? line[line.length - 1]?.v;
  const delta = start !== undefined && shown !== undefined ? shown - start : 0;

  const held = portfolio?.positions.find((p) => p.symbol === symbol);

  return (
    <div className="trade surface">
      <div className="symbols">
        {symbols.map((s) => (
          <button key={s} className={`chip ${s === symbol ? "on" : ""}`} onClick={() => onSymbol(s)}>
            {s}
          </button>
        ))}
      </div>

      <div className="price-big num">{shown !== undefined ? money(shown) : "—"}</div>
      <div className={`change num ${tone(delta)}`}>
        {start !== undefined && shown !== undefined && (
          <>
            {delta >= 0 ? "▲" : "▼"} {signed(delta).replace(/^[+−]/, "")} ({pct((delta / start) * 100)})
            <span className="muted" style={{ fontWeight: 400 }}>
              {" "}{scrub ? new Date(scrub.t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : RANGES[range].label}
            </span>
          </>
        )}
      </div>

      <div className="chart-wrap">
        <PriceChart series={line} baseline={start} onScrub={setScrub} height={280} />
      </div>

      <div className="ranges">
        <div className="seg">
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        {book?.spread && (
          <span className="note muted num" style={{ fontSize: 13 }}>
            {money(book.best_bid!.cents)} bid · {money(book.best_ask!.cents)} ask
          </span>
        )}
      </div>

      <div className="actions">
        <button className="btn btn-buy" onClick={() => onTrade("buy")}>Buy</button>
        <button className="btn btn-sell" onClick={() => onTrade("sell")}>Sell</button>
      </div>

      <div className="holding">
        {held && held.quantity > 0 ? (
          <>
            <span>You own <b className="num">{held.quantity}</b> {symbol}</span>
            <span className="num">
              {held.market_value && money(held.market_value.cents)}
              {held.unrealized_pnl && (
                <span className={tone(held.unrealized_pnl.cents)}> · {signed(held.unrealized_pnl.cents)}</span>
              )}
            </span>
          </>
        ) : (
          <span className="muted">You don't own any {symbol} yet.</span>
        )}
      </div>
    </div>
  );
}
