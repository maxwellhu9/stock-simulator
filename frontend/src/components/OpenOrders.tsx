import type { Order } from "../types";

const LIVE = new Set(["open", "partially_filled"]);

export function OpenOrders({
  orders,
  onCancel,
}: {
  orders: Order[];
  onCancel: (id: number) => void;
}) {
  return (
    <div className="panel">
      <h2>Your orders</h2>
      {orders.length === 0 ? (
        <div className="empty">no orders yet</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Side</th><th>Price</th><th>Filled</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className={o.side === "buy" ? "bid-px" : "ask-px"}>
                  {o.side}
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {o.limit_price ? o.limit_price.display : "mkt"}
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {o.filled_quantity}/{o.quantity}
                </td>
                <td style={{ textAlign: "right" }}>
                  <span className="pill">{o.status.replace("_", " ")}</span>
                </td>
                <td style={{ textAlign: "right" }}>
                  {LIVE.has(o.status) && (
                    <button className="link" onClick={() => onCancel(o.id)}>
                      cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
