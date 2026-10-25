import type {
  Book,
  Candle,
  HistoryPoint,
  Money,
  Order,
  PlaceOrderResult,
  Population,
  Portfolio,
  ShockResult,
  Side,
  SimState,
  Trade,
} from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8077";

/** An error the server rejected us with, carrying its explanation. */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = Array.isArray(body.detail)
        ? body.detail
            .map((e: { loc: string[]; msg: string }) =>
              `${e.loc.slice(1).join(".")}: ${e.msg}`,
            )
            .join("; ")
        : (body.detail ?? detail);
    } catch {
      /* no JSON body */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

const put = (body: unknown): RequestInit => ({
  method: "PUT",
  body: JSON.stringify(body),
});
const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

export const api = {
  createAccount: (name: string, initial_cash: string) =>
    request<Portfolio>("/accounts", post({ name, initial_cash })),
  portfolio: (name: string) =>
    request<Portfolio>(`/accounts/${encodeURIComponent(name)}`),

  placeOrder: (body: {
    account: string;
    symbol: string;
    side: Side;
    quantity: number;
    limit_price: string | null;
  }) => request<PlaceOrderResult>("/orders", post(body)),
  cancelOrder: (id: number) =>
    request<Order>(`/orders/${id}`, { method: "DELETE" }),
  orders: (account: string) =>
    request<Order[]>(`/orders?account=${encodeURIComponent(account)}&limit=100`),

  book: (symbol: string, levels = 6) =>
    request<Book>(`/book/${symbol}?levels=${levels}`),
  trades: (symbol: string, limit = 20) =>
    request<Trade[]>(`/trades/${symbol}?limit=${limit}`),
  candles: (symbol: string, seconds: number, limit: number) =>
    request<Candle[]>(`/candles/${symbol}?seconds=${seconds}&limit=${limit}`),

  symbols: () => request<{ symbol: string; mid: Money }[]>("/symbols"),

  sim: () => request<SimState>("/sim"),
  simHistory: (symbol: string) =>
    request<HistoryPoint[]>(`/sim/history/${symbol}`),
  setPopulation: (p: Population) => request<SimState>("/sim/population", put(p)),
  setControls: (c: { sentiment?: number; speed?: number; paused?: boolean }) =>
    request<SimState>("/sim/controls", put(c)),
  shock: (symbol: string, side: Side, quantity: number) =>
    request<ShockResult>("/sim/shock", post({ symbol, side, quantity })),
};
