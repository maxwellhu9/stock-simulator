// Mirrors app/schemas.py on the backend.

export type Side = "buy" | "sell";

export type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "expired";

// Money always arrives twice: exact integer cents for arithmetic, and a
// preformatted string for display. Never do money math on the display string.
export interface Money {
  cents: number;
  display: string;
}

export interface PositionOut {
  symbol: string;
  quantity: number;
  reserved: number;
  available: number;
  avg_cost: Money | null;
  last_price: Money | null;
  market_value: Money | null;
  unrealized_pnl: Money | null;
}

export interface Portfolio {
  name: string;
  cash: Money;
  reserved: Money;
  available: Money;
  positions: PositionOut[];
  positions_value: Money | null;
  total_value: Money | null;
  unrealized_pnl: Money | null;
  realized_pnl: Money | null;
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
  buyer: string | null;
  seller: string | null;
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

export interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Population {
  value: number;
  momentum: number;
  noise: number;
  maker: number;
}

export interface SimState {
  population: Population;
  sentiment: number;
  speed: number;
  paused: boolean;
  symbols: { symbol: string; last: Money; fair: Money }[];
}

export interface HistoryPoint {
  t: number;
  price: number;
  fair: number;
}

export interface ShockResult {
  side: Side;
  requested: number;
  filled: number;
  fill_rate: number;
  price_before: Money;
  avg_fill: Money;
  slippage_pct: number;
  orders_hit: number;
}
