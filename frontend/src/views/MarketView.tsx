import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Headline } from "../components/Headline";
import { OrderBook } from "../components/OrderBook";
import { PriceChart } from "../components/PriceChart";
import { money, who } from "../format";
import { stockColor } from "../symbols";
import type {
  Book, HistoryPoint, MarketEvent, Population, ScenarioInfo, ShockResult, Side, SimState, Trade,
} from "../types";

const CROWD: { key: keyof Population; name: string; desc: string; max: number }[] = [
  { key: "value", name: "Value traders", desc: "Buy when it's cheap, sell when it's expensive", max: 30 },
  { key: "momentum", name: "Momentum traders", desc: "Buy what's rising, sell what's falling", max: 30 },
  { key: "noise", name: "Noise traders", desc: "Buy and sell for no particular reason", max: 30 },
  { key: "maker", name: "Market makers", desc: "Always offer to buy and sell", max: 12 },
];
const SIZES = [500, 1_500, 5_000];

/** Which colour dot a trade side gets. */
function kind(label: string | null, me: string): string {
  if (label === me) return "you";
  if (label === "big order") return "big";
  return label && ["value", "momentum", "noise", "maker"].includes(label) ? label : "you";
}

interface Props {
  account: string;
  symbol: string;
  symbols: string[];
  onSymbol: (s: string) => void;
  book: Book | null;
  trades: Trade[];
  events: MarketEvent[];
  onEvent: () => void;
}

export function MarketView({ account, symbol, symbols, onSymbol, book, trades, events, onEvent }: Props) {
  const [sim, setSim] = useState<SimState | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [mood, setMood] = useState(0);
  const [size, setSize] = useState(1_500);
  const [shock, setShock] = useState<ShockResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);

  useEffect(() => {
    api.scenarios().then(setScenarios).catch(() => undefined);
  }, []);

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

  async function control(c: { sentiment?: number; speed?: number; paused?: boolean; random_news?: boolean }) {
    const s = await act(() => api.setControls(c));
    if (s) setSim(s);
  }

  async function happen(fn: () => Promise<unknown>) {
    setBusy(true);
    const r = await act(fn);
    if (r && typeof r === "object" && "population" in r) setSim(r as SimState);
    onEvent();
    setBusy(false);
  }

  async function drop(side: Side) {
    setBusy(true);
    const r = await act(() => api.shock(symbol, side, size));
    if (r) setShock(r);
    setBusy(false);
  }

  const here = sim?.symbols.find((s) => s.symbol === symbol);
  const paused = sim?.paused ?? false;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Market lab</h1>
          <p>Every other trader here is a bot. Change who's trading and see what the price does.</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div className="symbols">
            {symbols.map((s) => (
              <button key={s} className={`chip ${s === symbol ? "on" : ""}`} onClick={() => onSymbol(s)}>
                <i style={{ background: stockColor(s) }} />{s}
              </button>
            ))}
          </div>
          <span className={`live-dot ${paused ? "paused" : ""}`}>{paused ? "Paused" : `Live · ${sim?.speed ?? 1}×`}</span>
        </div>
      </div>

      {error && <div className="err">{error}</div>}

      <div className="grid">
        <div className="card span-8 stretch">
          <Headline event={events[0]} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
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
            height={290}
            series={history.map((p) => ({ t: p.t, v: p.price }))}
            reference={history.map((p) => ({ t: p.t, v: p.fair }))}
            markers={events
              .filter((e) => e.kind !== "scenario" || e.headline.endsWith(" begins"))
              .map((e) => ({ t: e.t, tone: e.kind === "good" ? "up" : e.kind === "bad" ? "down" : "accent" }))}
          />
          <p className="note muted" style={{ fontSize: 13, margin: "8px 0 0" }}>
            Price is wherever the last trade happened. It moves when buyers and sellers disagree about what it's worth.
          </p>
        </div>

        <div className="card span-4 stretch">
          <h2 className="card-title">Scenarios</h2>
          {sim?.scenario ? (
            <div className="running">
              <span><b>{sim.scenario.name}</b> in progress</span>
              <span className="num">{Math.ceil(sim.scenario.ends_in)}s left</span>
            </div>
          ) : (
            <div className="running idle"><span>No scenario running</span></div>
          )}
          <div className="happen">
            <button className="good" disabled={busy} onClick={() => happen(() => api.news(symbol, true))}>Good news</button>
            <button className="bad" disabled={busy} onClick={() => happen(() => api.news(symbol, false))}>Bad news</button>
            {scenarios.map((sc) => (
              <button key={sc.key} title={sc.description} aria-label={sc.name} disabled={busy}
                      onClick={() => happen(() => api.runScenario(sc.key, symbol))}>
                {sc.name}
              </button>
            ))}
            <button className="calm" disabled={busy} onClick={() => happen(() => api.runScenario("calm", symbol))}>
              Calm down
            </button>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={sim?.random_news ?? true}
                   onChange={(e) => control({ random_news: e.target.checked })} />
            Random news about once a minute
          </label>
        </div>

        <div className="card span-4 stretch">
          <h2 className="card-title">The crowd</h2>
          {CROWD.map((c) => {
            const n = sim?.population[c.key] ?? 0;
            return (
              <div className="crowd-row" key={c.key}>
                <div className="what">
                  <div className="name"><span className={`dot ${c.key}`} />{c.name}</div>
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

        <div className="card span-4 stretch">
          <h2 className="card-title">Mood and speed</h2>
          <input className="slider" type="range" min={-1} max={1} step={0.1} value={mood}
                 aria-label="mood"
                 onChange={(e) => setMood(Number(e.target.value))}
                 onPointerUp={() => control({ sentiment: mood })}
                 onKeyUp={() => control({ sentiment: mood })} />
          <div className="slider-ends"><span>Pessimistic</span><span>Optimistic</span></div>
          <p className="note muted" style={{ fontSize: 13, margin: "10px 0 18px" }}>
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

        <div className="card span-4 stretch">
          <h2 className="card-title">Drop a big order</h2>
          <p className="note" style={{ margin: 0, fontSize: 13 }}>
            One trader buys or sells a lot at once, at any price. How far does it push the market?
          </p>
          <div className="seg" style={{ marginTop: 12 }}>
            {SIZES.map((s) => (
              <button key={s} className={s === size ? "on" : ""} onClick={() => setSize(s)}>{s.toLocaleString()}</button>
            ))}
          </div>
          <div className="shock-buttons">
            <button className="btn btn-sell" disabled={busy} onClick={() => drop("sell")}>Sell them all</button>
            <button className="btn btn-buy" disabled={busy} onClick={() => drop("buy")}>Buy them all</button>
          </div>
          {shock && <ShockOutcome r={shock} />}
        </div>

        <div className="card span-8 stretch">
          <h2 className="card-title">Latest trades</h2>
          {trades.length === 0 ? (
            <p className="empty">No trades yet.</p>
          ) : (
            <ul className="feed">
              {trades.slice(0, 10).map((t) => {
                const buyer = who(t.buyer, account);
                const seller = who(t.seller, account);
                const from =
                  seller === "You" ? "you"
                  : t.buyer === t.seller && buyer !== "You"
                    ? "another " + seller.replace(/^(A|An|Another) /, "")
                    : seller.charAt(0).toLowerCase() + seller.slice(1);
                return (
                  <li key={t.id} className={buyer === "You" || seller === "You" ? "mine" : ""}>
                    <span style={{ display: "flex", alignItems: "baseline" }}>
                      <span className={`dot ${kind(t.buyer, account)}`} />
                      <span>{buyer} bought {t.quantity} from {from}</span>
                    </span>
                    <span className="num soft">{money(t.price.cents)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card span-4 stretch">
          <h2 className="card-title">Order book</h2>
          <OrderBook book={book} />
        </div>
      </div>
    </>
  );
}

function ShockOutcome({ r }: { r: ShockResult }) {
  const selling = r.side === "sell";
  const leftover = r.requested - r.filled;
  if (r.filled === 0) {
    return <div className="outcome"><b>Nothing happened.</b> There was no one on the other side.</div>;
  }
  return (
    <div className="outcome">
      <b className="num">{selling ? "Sold" : "Bought"} {r.filled.toLocaleString()} of {r.requested.toLocaleString()}.</b>
      <br />
      Average {money(r.avg_fill.cents)}, {Math.abs(r.slippage_pct).toFixed(2)}% {selling ? "below" : "above"} where it started.
      {" "}
      {leftover > 0
        ? `The other ${leftover.toLocaleString()} found no ${selling ? "buyers" : "sellers"}.`
        : `It took ${r.orders_hit} ${selling ? "buyers" : "sellers"} to absorb it.`}
    </div>
  );
}
