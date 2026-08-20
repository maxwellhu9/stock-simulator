import type {
  Book,
  Order,
  PlaceOrderResult,
  Portfolio,
  Side,
  SymbolInfo,
  Trade,
} from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8077";

/** Errors the server rejected us with, carrying its explanation.
 *
 *  Written with an explicit field rather than a constructor parameter property
 *  (`constructor(readonly status: number)`), because that is TypeScript-only
 *  syntax that has to be compiled away -- and this project builds with
 *  `erasableSyntaxOnly`, which permits only types that vanish on erasure. */
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
      // Business errors send a string; validation errors send a list of
      // field-level problems. Flatten both into one readable line.
      detail = Array.isArray(body.detail)
        ? body.detail
            .map((e: { loc: string[]; msg: string }) =>
              `${e.loc.slice(1).join(".")}: ${e.msg}`,
            )
            .join("; ")
        : (body.detail ?? detail);
    } catch {
      /* response had no JSON body */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  createAccount: (name: string, initial_cash: string) =>
    request<Portfolio>("/accounts", {
      method: "POST",
      body: JSON.stringify({ name, initial_cash }),
    }),

  portfolio: (name: string) =>
    request<Portfolio>(`/accounts/${encodeURIComponent(name)}`),

  deposit: (name: string, amount: string) =>
    request<Portfolio>(`/accounts/${encodeURIComponent(name)}/deposit`, {
      method: "POST",
      body: JSON.stringify({ amount }),
    }),

  placeOrder: (body: {
    account: string;
    symbol: string;
    side: Side;
    quantity: number;
    limit_price: string | null;
  }) =>
    request<PlaceOrderResult>("/orders", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  cancelOrder: (id: number) =>
    request<Order>(`/orders/${id}`, { method: "DELETE" }),

  orders: (account?: string, symbol?: string) => {
    const q = new URLSearchParams();
    if (account) q.set("account", account);
    if (symbol) q.set("symbol", symbol);
    return request<Order[]>(`/orders?${q}`);
  },

  book: (symbol: string, levels = 8) =>
    request<Book>(`/book/${encodeURIComponent(symbol)}?levels=${levels}`),

  symbols: () => request<SymbolInfo[]>("/symbols"),

  trades: (symbol: string, limit = 20) =>
    request<Trade[]>(`/trades/${encodeURIComponent(symbol)}?limit=${limit}`),
};
