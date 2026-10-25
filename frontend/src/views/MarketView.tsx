import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { PriceChart } from "../components/PriceChart";
import { money, who } from "../format";
import type { Book, HistoryPoint, Population, ShockResult, Side, SimState, Trade } from "../types";

const CROWD: { key: keyof Population; name: string; desc: string; max: number }[] = [
  { key: "value", name: "Value traders", desc: "Buy when it's cheap, sell when it's expensive", max: 30 },
  { key: "momentum", name: "Momentum traders", desc: "Buy what's rising, sell what's falling", max: 30 },
  { key: "noise", name: "Noise traders", desc: "Buy and sell for no particular reason", max: 30 },
  { key: "maker", name: "Market makers", desc: "Always offer to buy and sell, for a small margin", max: 12 },
];
const SIZES = [500, 1_500, 5_000];

interface Props {
  account: string;
  symbol: string;
  symbols: string[];
  onSymbol: (s: string) => void;
  book: Book | null;
  trades: Trade[];
}

export function MarketView({ account, symbol, symbols, onSymbol, book, trades }: Props) {
  const [sim, setSim] = useState<SimState | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [mood, setMood] = useState(0);
  const [size, setSize] = useState(1_500);
  const [shock, setShock] = useState<ShockResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.sim().then((s) => alive && setSim(s)).catch(() => undefined);
      api.simHistory(symbol).then((h) => alive && setHistory(h)).catch(() => undefined);
    };
    load();
    const id = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol]);

  // Take the server's mood once, then let the slider own it while dragging.
  useEffect(() => {
    if (sim) setMood(sim.sentiment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim === null]);

  useEffect(() => setShock(null), [symbol]);

  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function step(key: keyof Population, by: number) {
    if (!sim) return;
    const next = { ...sim.population, [key]: sim.population[key] + by };
    setSim({ ...sim, population: next });
    const s = await act(() => api.setPopulation(next));
    if (s) setSim(s);
  }

  async function control(c: { sentiment?: number; speed?: number; paused?: boolean }) {
    const s = await act(() => api.setControls(c));
    if (s) setSim(s);
  }

  async function drop(side: Side) {
    setBusy(true);
    const r = await act(() => api.shock(symbol, side, size));
    if (r) setShock(r);
    setBusy(false);
  }

  const here = sim?.symbols.find((s) => s.symbol === symbol);
  const paused = sim?.paused ?? false;
  const recent = trades.slice(0, 12);

  return (
    <div className="market">
      <div className="market-head">
        <h1>Who's trading {symbol}</h1>
        <div className="symbols" style={{ margin: 0 }}>
          {symbols.map((s) => (
            <button key={s} className={`chip ${s === symbol ? "on" : ""}`} onClick={() => onSymbol(s)}>{s}</button>
          ))}
        </div>
        <span className={`live-dot ${paused ? "paused" : ""}`} style={{ marginLeft: "auto" }}>
          {paused ? "Paused" : `Live · ${sim?.speed ?? 1}×`}
        </span>
      </div>
      <p className="note" style={{ margin: 0, maxWidth: 620 }}>
        Every trade here comes from simulated traders using the same matching engine you do.
        Change who's in the market and watch what happens to the price.
      </p>

      {error && <div className="err" style={{ marginTop: 16 }}>{error}</div>}

      <div className="market-grid">
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div className="legend">
              <span><i />Price</span>
              <span><i className="dash" />What it's worth</span>
            </div>
            {here && (
              <span className="num" style={{ fontSize: 15 }}>
                <b>{money(here.last.cents)}</b>
                <span className="muted"> · worth {money(here.fair.cents)}</span>
              </span>
            )}
          </div>
          <PriceChart
            colorBy="ink"
            height={300}
            series={history.map((p) => ({ t: p.t, v: p.price }))}
            reference={history.map((p) => ({ t: p.t, v: p.fair }))}
          />
          <p className="note muted" style={{ fontSize: 13, marginTop: 8 }}>
            Price is wherever the last trade happened. Nothing sets it directly — it moves
            when buyers and sellers disagree about what it's worth.
          </p>

          <h3 className="section-title" style={{ marginTop: 36 }}>Latest trades</h3>
          {recent.length === 0 ? (
            <p className="empty">No trades yet.</p>
          ) : (
            <ul className="feed">
              {recent.map((t) => {
                const buyer = who(t.buyer, account);
                const seller = who(t.seller, account);
                // Two of the same kind trading with each other: "from another value trader".
                const from =
                  seller === "You" ? "you"
                  : t.buyer === t.seller && buyer !== "You"
                    ? "another " + seller.replace(/^(A|An|Another) /, "")
                    : seller.charAt(0).toLowerCase() + seller.slice(1);
                return (
                  <li key={t.id} className={buyer === "You" || seller === "You" ? "mine" : ""}>
                    <span>{buyer} bought {t.quantity} from {from}</span>
                    <span className="num soft">{money(t.price.cents)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <div className="block">
            <h3 className="section-title">The crowd</h3>
            {CROWD.map((c) => {
              const n = sim?.population[c.key] ?? 0;
              return (
                <div className="crowd-row" key={c.key}>
                  <div className="what">
                    <div className="name">{c.name}</div>
                    <div className="desc">{c.desc}</div>
                  </div>
                  <div className="stepper">
                    <button aria-label={`fewer ${c.name}`} disabled={!sim || n <= 0} onClick={() => step(c.key, -1)}>−</button>
                    <b>{n}</b>
                    <button aria-label={`more ${c.name}`} disabled={!sim || n >= c.max} onClick={() => step(c.key, 1)}>+</button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="block">
            <h3 className="section-title">Mood</h3>
            <input className="slider" type="range" min={-1} max={1} step={0.1} value={mood}
                   onChange={(e) => setMood(Number(e.target.value))}
                   onPointerUp={() => control({ sentiment: mood })}
                   onKeyUp={() => control({ sentiment: mood })} />
            <div className="slider-ends"><span>Pessimistic</span><span>Optimistic</span></div>
            <p className="note muted" style={{ fontSize: 13, margin: "10px 0 16px" }}>
              Nudges what the market thinks it's worth, a little more each second.
            </p>
            <div className="seg">
              <button className={paused ? "on" : ""} onClick={() => control({ paused: true })}>Pause</button>
              {[1, 2, 4].map((s) => (
                <button key={s} className={!paused && sim?.speed === s ? "on" : ""}
                        onClick={() => control({ speed: s, paused: false })}>{s}×</button>
              ))}
            </div>
          </div>

          <div className="block">
            <h3 className="section-title">Drop a big order</h3>
            <p className="note" style={{ margin: 0 }}>
              One trader buys or sells a lot at once, at any price. How far does it push the market?
            </p>
            <div className="seg" style={{ marginTop: 14 }}>
              {SIZES.map((s) => (
                <button key={s} className={s === size ? "on" : ""} onClick={() => setSize(s)}>
                  {s.toLocaleString()} shares
                </button>
              ))}
            </div>
            <div className="shock-buttons">
              <button className="btn btn-sell" disabled={busy} onClick={() => drop("sell")}>Sell them all</button>
              <button className="btn btn-buy" disabled={busy} onClick={() => drop("buy")}>Buy them all</button>
            </div>
            {shock && <ShockOutcome r={shock} />}
          </div>

          <div className="block">
            <h3 className="section-title">Order book</h3>
            <OrderBook book={book} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ShockOutcome({ r }: { r: ShockResult }) {
  const selling = r.side === "sell";
  const verb = selling ? "Sold" : "Bought";
  const leftover = r.requested - r.filled;
  const move = Math.abs(r.slippage_pct).toFixed(2);

  if (r.filled === 0) {
    return <div className="outcome"><b>Nothing happened.</b> There was no one on the other side.</div>;
  }
  return (
    <div className="outcome">
      <b className="num">{verb} {r.filled.toLocaleString()} of {r.requested.toLocaleString()} shares.</b>
      <br />
      Average price {money(r.avg_fill.cents)}, {move}% {selling ? "below" : "above"} where it started.
      {" "}
      {leftover > 0
        ? `The other ${leftover.toLocaleString()} found no ${selling ? "buyers" : "sellers"} at any price — the book ran out.`
        : `It took ${r.orders_hit} ${selling ? "buyers" : "sellers"} to absorb it.`}
    </div>
  );
}

function OrderBook({ book }: { book: Book | null }) {
  if (!book || (!book.bids.length && !book.asks.length)) {
    return <p className="empty">Empty.</p>;
  }
  const max = Math.max(1, ...book.bids.map((l) => l.quantity), ...book.asks.map((l) => l.quantity));
  const row = (l: Book["bids"][number], side: "bid" | "ask") => (
    <tr key={side + l.price.cents}>
      <td>
        <span className={`px ${side === "bid" ? "up" : "down"}`}>{money(l.price.cents)}</span>
      </td>
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
        {[...book.asks].reverse().map((l) => row(l, "ask"))}
        <tr className="spread"><td>Spread</td><td>{book.spread ? money(book.spread.cents) : "—"}</td></tr>
        {book.bids.map((l) => row(l, "bid"))}
      </tbody>
    </table>
  );
}
