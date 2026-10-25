import { useCallback, useEffect, useState } from "react";
import { ApiError, DEMO, api } from "./api";
import { OrderSheet } from "./components/OrderSheet";
import type { MarketEvent, Order, Portfolio, Side } from "./types";
import { useMarketSocket } from "./useMarketSocket";
import { Icon } from "./components/Icon";
import { HomeView } from "./views/HomeView";
import { MarketView } from "./views/MarketView";
import { PortfolioView } from "./views/PortfolioView";
import { StockView } from "./views/StockView";

type Tab = "home" | "stock" | "market" | "portfolio";
const TABS: [Tab, string, string][] = [
  ["home", "Home", "home"],
  ["stock", "Stocks", "stocks"],
  ["market", "Market lab", "lab"],
  ["portfolio", "Portfolio", "portfolio"],
];
const KNOWN: Tab[] = ["home", "stock", "market", "portfolio"];

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable; the app still works for this session */
  }
}

export default function App() {
  const [account, setAccount] = useState<string | null>(() => stored("account"));
  const [tab, setTab] = useState<Tab>(() => {
    const t = stored("tab") as Tab | null;
    return t && KNOWN.includes(t) ? t : "home";
  });
  const [symbol, setSymbol] = useState(() => stored("symbol") ?? "AAPL");
  const [symbols, setSymbols] = useState<string[]>(["AAPL", "NVDA", "MSFT"]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [sheet, setSheet] = useState<Side | null>(null);
  const [events, setEvents] = useState<MarketEvent[]>([]);

  const { book, trades, last } = useMarketSocket(symbol);

  const refresh = useCallback(async () => {
    if (!account) return;
    try {
      const [p, o] = await Promise.all([api.portfolio(account), api.orders(account)]);
      setPortfolio(p);
      setOrders(o);
    } catch (e) {
      // A remembered account that no longer exists (reset database, say).
      if (e instanceof ApiError && e.status === 404) {
        store("account", null);
        setAccount(null);
      }
    }
  }, [account]);

  // Simulated traders can fill a resting order at any moment, so keep checking.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    api.symbols().then((s) => s.length && setSymbols(s.map((x) => x.symbol))).catch(() => undefined);
  }, []);

  // Every symbol's events in one list; each page filters to what it shows.
  const loadEvents = useCallback(() => {
    api.events().then(setEvents).catch(() => undefined);
  }, []);
  const symbolEvents = events.filter((e) => !e.symbol || e.symbol === symbol);
  const open = (s: string) => {
    setSymbol(s);
    setTab("stock");
  };

  useEffect(() => {
    loadEvents();
    const id = setInterval(loadEvents, 2000);
    return () => clearInterval(id);
  }, [loadEvents]);

  useEffect(() => store("tab", tab), [tab]);
  useEffect(() => store("symbol", symbol), [symbol]);

  if (!account) {
    return <SignIn onSignIn={(n) => { store("account", n); setAccount(n); }} />;
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">Exchange</div>
        {TABS.map(([k, label, icon]) => (
          <button key={k} className={`nav-item ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
            <Icon name={icon} />{label}
          </button>
        ))}
        <div className="side-foot">
          <div className="who-name">{account}</div>
          <button className="link" onClick={() => { store("account", null); setAccount(null); setPortfolio(null); }}>
            Switch account
          </button>
        </div>
      </aside>

      <main className="main">
        {tab === "home" && (
          <HomeView account={account} symbols={symbols} portfolio={portfolio} orders={orders}
                    events={events} onOpen={open} />
        )}
        {tab === "stock" && (
          <StockView symbol={symbol} symbols={symbols} onSymbol={setSymbol}
                     last={last} book={book} portfolio={portfolio} onTrade={setSheet}
                     events={symbolEvents} />
        )}
        {tab === "market" && (
          <MarketView account={account} symbol={symbol} symbols={symbols} onSymbol={setSymbol}
                      book={book} trades={trades} events={symbolEvents} onEvent={loadEvents} />
        )}
        {tab === "portfolio" && (
          <PortfolioView portfolio={portfolio} orders={orders} onOpen={open}
                         onCancel={async (id) => { await api.cancelOrder(id).catch(() => undefined); refresh(); }} />
        )}
      </main>

      {sheet && (
        <OrderSheet account={account} symbol={symbol} initialSide={sheet} book={book}
                    portfolio={portfolio} onClose={() => setSheet(null)} onPlaced={refresh} />
      )}
    </div>
  );
}

function SignIn({ onSignIn }: { onSignIn: (name: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go() {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      await api.portfolio(clean);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        try {
          await api.createAccount(clean, "100000.00");
        } catch (e2) {
          setError(e2 instanceof ApiError ? e2.message : String(e2));
          setBusy(false);
          return;
        }
      } else {
        setError(e instanceof ApiError ? e.message : "Can't reach the exchange. Is the server running?");
        setBusy(false);
        return;
      }
    }
    onSignIn(clean);
  }

  return (
    <div className="signin card">
      <h1>Exchange</h1>
      <p className="note">
        Practice trading against a market full of simulated traders. New names start
        with $100,000.{DEMO && " This version runs in your browser, so reloading starts a fresh market."}
      </p>
      {error && <div className="err">{error}</div>}
      <label className="field">
        <span>Your name</span>
        <input className="input" value={name} autoFocus
               onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && go()} />
      </label>
      <button className="btn btn-ink" style={{ width: "100%" }} disabled={busy || !name.trim()} onClick={go}>
        {busy ? "One sec…" : "Start trading"}
      </button>
    </div>
  );
}
