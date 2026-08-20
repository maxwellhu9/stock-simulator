import type { Trade } from "../types";

export function TradeTape({ trades }: { trades: Trade[] }) {
  return (
    <div className="panel">
      <h2>Trades</h2>
      {trades.length === 0 ? (
        <div className="empty">nothing has traded yet</div>
      ) : (
        <table>
          <thead>
            <tr><th>Time</th><th>Price</th><th>Size</th></tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id}>
                <td className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>
                  {new Date(t.created_at).toLocaleTimeString()}
                </td>
                <td className="mono" style={{ textAlign: "right" }}>{t.price.display}</td>
                <td className="mono" style={{ textAlign: "right" }}>{t.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
