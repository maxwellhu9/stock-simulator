import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { OpenOrders } from "./components/OpenOrders";
import { OrderBookPanel } from "./components/OrderBookPanel";
import { OrderEntry } from "./components/OrderEntry";
import { PortfolioPanel } from "./components/PortfolioPanel";
import { TradeTape } from "./components/TradeTape";
import { useMarketSocket } from "./useMarketSocket";
import type { Order, Portfolio, Side, SymbolInfo } from "./types";

export default function App() {
  const [account, setAccount] = useState<string | null>(
    () => localStorage.getItem("account"),
  );
  const [nameInput, setNameInput] = useState("");
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [symbol, setSymbol] = useState(
    () => localStorage.getItem("symbol") ?? "AAPL",
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Your own cash and orders -- the socket carries the market, not this. */
  const refreshMe = useCallback(async () => {
    if (!account) return;
    try {
      const [p, o] = await Promise.all([
        api.portfolio(account),
        api.orders(account, symbol),
      ]);
      setPortfolio(p);
      setOrders(o);
    } catch (e) {
      // The remembered account no longer exists (a reset database, say). Drop
      // back to sign-in rather than leaving a permanent error on screen.
      if (e instanceof ApiError && e.status === 404) {
        localStorage.removeItem("account");
        setAccount(null);
        setPortfolio(null);
        return;
      }
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [account, symbol]);

  // The book and the tape arrive by push, not by asking on a timer.
  const { book, trades, connected } = useMarketSocket(symbol, refreshMe);

  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    api.symbols().then(setSymbols).catch(() => undefined);
  }, []);

  useEffect(() => {
    localStorage.setItem("symbol", symbol);
  }, [symbol]);

  async function signIn(name: string) {
    setError(null);
    const clean = name.trim();
    if (!clean) return;
    try {
      await api.portfolio(clean);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        await api.createAccount(clean, "100000.00");
        setNotice(`Created ${clean} with $100,000.00 to trade.`);
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
        return;
      }
    }
    localStorage.setItem("account", clean);
    setAccount(clean);
  }

  async function placeOrder(o: {
    side: Side;
    quantity: number;
    limit_price: string | null;
  }) {
    if (!account) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.placeOrder({ account, symbol, ...o });
      const filled = res.trades.reduce((n, t) => n + t.quantity, 0);
      setNotice(
        filled > 0
          ? `Filled ${filled} of ${res.order.quantity} — ${res.trades
              .map((t) => `${t.quantity} @ ${t.price.display}`)
              .join(", ")}`
          : `Order resting on the book: ${res.order.quantity} @ ${res.order.limit_price?.display}`,
      );
      await refreshMe();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: number) {
    setError(null);
    try {
      await api.cancelOrder(id);
      setNotice(`Order #${id} cancelled — reservation released.`);
      await refreshMe();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (!account) {
    return (
      <div style={{ maxWidth: 380, margin: "18vh auto", padding: 20 }}>
        <h1 style={{ fontSize: 19, marginBottom: 6 }}>Paper Exchange</h1>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
          Pick a name. New names start with $100,000 to trade. Open a second
          browser window with a different name to trade against yourself.
        </p>
        {error && <div className="err">{error}</div>}
        <div className="field">
          <label>Account name</label>
          <input
            value={nameInput}
            autoFocus
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && signIn(nameInput)}
          />
        </div>
        <button className="submit buy" onClick={() => signIn(nameInput)}>
          Start trading
        </button>
      </div>
    );
  }

  return (
    <>
      <header className="top">
        <h1>Paper Exchange</h1>
        <select
          className="symsel"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
        >
          {(symbols.length ? symbols.map((s) => s.symbol) : [symbol]).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>
          bid {book?.best_bid?.display ?? "—"} / ask {book?.best_ask?.display ?? "—"}
        </span>
        <span className={`live ${connected ? "on" : "off"}`}>
          {connected ? "live" : "reconnecting…"}
        </span>
        <div className="right">
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            signed in as <strong style={{ color: "var(--text)" }}>{account}</strong>
          </span>
          <button
            className="ghost"
            onClick={() => {
              localStorage.removeItem("account");
              setAccount(null);
              setPortfolio(null);
            }}
          >
            switch
          </button>
        </div>
      </header>

      <div className="layout">
        <div style={{ display: "grid", gap: 14 }}>
          <OrderBookPanel book={book} />
          <TradeTape trades={trades} />
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          {error && <div className="err">{error}</div>}
          {notice && !error && <div className="ok">{notice}</div>}
          <OrderEntry
            account={account}
            symbol={symbol}
            book={book}
            onSubmit={placeOrder}
            busy={busy}
          />
          <OpenOrders orders={orders} onCancel={cancel} />
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <PortfolioPanel p={portfolio} />
        </div>
      </div>
    </>
  );
}
