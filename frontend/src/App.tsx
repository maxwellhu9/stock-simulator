import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { OrderSheet } from "./components/OrderSheet";
import type { Order, Portfolio, Side } from "./types";
import { useMarketSocket } from "./useMarketSocket";
import { MarketView } from "./views/MarketView";
import { PortfolioView } from "./views/PortfolioView";
import { TradeView } from "./views/TradeView";

type Tab = "trade" | "market" | "portfolio";
const TABS: [Tab, string][] = [["trade", "Trade"], ["market", "Market"], ["portfolio", "Portfolio"]];

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
  const [tab, setTab] = useState<Tab>(() => (stored("tab") as Tab) ?? "trade");
  const [symbol, setSymbol] = useState(() => stored("symbol") ?? "AAPL");
  const [symbols, setSymbols] = useState<string[]>(["AAPL", "NVDA", "MSFT"]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [sheet, setSheet] = useState<Side | null>(null);

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

  useEffect(() => store("tab", tab), [tab]);
  useEffect(() => store("symbol", symbol), [symbol]);

  if (!account) {
    return <SignIn onSignIn={(n) => { store("account", n); setAccount(n); }} />;
  }

  return (
    <>
      <header className="top">
        <span className="wordmark">Exchange</span>
        <nav className="tabs">
          {TABS.map(([k, label]) => (
            <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="who">
          <span className="soft">{account}</span>
          <button className="link" onClick={() => { store("account", null); setAccount(null); setPortfolio(null); }}>
            Switch
          </button>
        </div>
      </header>

      <main>
        {tab === "trade" && (
          <TradeView symbol={symbol} symbols={symbols} onSymbol={setSymbol}
                     last={last} book={book} portfolio={portfolio} onTrade={setSheet} />
        )}
        {tab === "market" && (
          <MarketView account={account} symbol={symbol} symbols={symbols} onSymbol={setSymbol}
                      book={book} trades={trades} />
        )}
        {tab === "portfolio" && (
          <PortfolioView portfolio={portfolio} orders={orders}
                         onCancel={async (id) => { await api.cancelOrder(id).catch(() => undefined); refresh(); }} />
        )}
      </main>

      {sheet && (
        <OrderSheet account={account} symbol={symbol} initialSide={sheet} book={book}
                    portfolio={portfolio} onClose={() => setSheet(null)} onPlaced={refresh} />
      )}
    </>
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
    <div className="signin">
      <h1>Exchange</h1>
      <p className="note">
        Practice trading against a market full of simulated traders. New names start
        with $100,000.
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
