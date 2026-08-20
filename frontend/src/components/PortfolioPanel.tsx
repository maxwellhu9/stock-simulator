import type { Portfolio } from "../types";

export function PortfolioPanel({ p }: { p: Portfolio | null }) {
  if (!p) return <div className="panel"><h2>Portfolio</h2><div className="empty">no account selected</div></div>;

  return (
    <div className="panel">
      <h2>Portfolio · {p.name}</h2>
      <div className="body">
        <div className="stat">
          <span>cash</span>
          <span className="mono">{p.cash.display}</span>
        </div>
        <div className="stat">
          {/* The number that explains itself: committed to open orders, so it
              is neither spent nor spendable. */}
          <span>reserved on open orders</span>
          <span className="mono" style={{ color: "var(--warn)" }}>
            {p.reserved.cents ? `−${p.reserved.display}` : p.reserved.display}
          </span>
        </div>
        <div className="stat big" style={{ borderTop: "1px solid var(--border)" }}>
          <span style={{ color: "var(--muted)" }}>available</span>
          <span className="mono">{p.available.display}</span>
        </div>
      </div>

      <h2 style={{ borderTop: "1px solid var(--border)" }}>Positions</h2>
      {p.positions.length === 0 ? (
        <div className="empty">no positions</div>
      ) : (
        <table>
          <thead>
            <tr><th>Symbol</th><th>Qty</th><th>Held</th></tr>
          </thead>
          <tbody>
            {p.positions.map((q) => (
              <tr key={q.symbol}>
                <td>{q.symbol}</td>
                <td className="mono" style={{ textAlign: "right" }}>{q.quantity}</td>
                <td className="mono" style={{ textAlign: "right", color: "var(--warn)" }}>
                  {q.reserved || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
