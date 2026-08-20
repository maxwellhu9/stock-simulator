// Mirrors app/schemas.py on the backend.

export type Side = "buy" | "sell";

export type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "expired";

// Money always arrives twice: exact integer cents for arithmetic, and a
// preformatted string for display. Never do money math on the display string,
// and never use a JS number for cents beyond reading it.
export interface Money {
  cents: number;
  display: string;
}

export interface PositionOut {
  symbol: string;
  quantity: number;
  reserved: number;
  available: number;
}

export interface Portfolio {
  name: string;
  cash: Money;
  reserved: Money;
  available: Money;
  positions: PositionOut[];
}

export interface Order {
  id: number;
  account_id: number;
  symbol: string;
  side: Side;
  quantity: number;
  filled_quantity: number;
  remaining: number;
  limit_price: Money | null;
  status: OrderStatus;
  created_at: string;
}

export interface Trade {
  id: number;
  symbol: string;
  price: Money;
  quantity: number;
  notional: Money;
  buy_order_id: number;
  sell_order_id: number;
  created_at: string;
}

export interface Level {
  price: Money;
  quantity: number;
}

export interface Book {
  symbol: string;
  bids: Level[];
  asks: Level[];
  best_bid: Money | null;
  best_ask: Money | null;
  spread: Money | null;
}

export interface PlaceOrderResult {
  order: Order;
  trades: Trade[];
}

export interface SymbolInfo {
  symbol: string;
  mid: Money;
}
