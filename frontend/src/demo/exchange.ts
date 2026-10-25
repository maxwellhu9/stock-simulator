// A TypeScript port of backend/app/exchange.py, with plain Maps standing in for
// Postgres. Same three gates on every order: check, reserve, settle.

import { OrderBook, type Fill, type Side } from "./orderbook";

export class ExchangeError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type Status = "open" | "partially_filled" | "filled" | "cancelled" | "expired";

export interface Account {
  id: number;
  name: string;
  cash: number;
  reserved: number;
}

export interface Position {
  quantity: number;
  reserved: number;
}

export interface OrderRec {
  id: number;
  account: number;
  symbol: string;
  side: Side;
  quantity: number;
  filled: number;
  limit: number | null;
  reservedCents: number;
  reservedQty: number;
  status: Status;
  t: number;
}

export interface TradeRec {
  id: number;
  symbol: string;
  price: number;
  quantity: number;
  buyOrderId: number;
  sellOrderId: number;
  buyer: number;
  seller: number;
  t: number;
}

/** One-second candle. Charts aggregate these into whatever width they ask for. */
export interface Bar {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Basis {
  quantity: number;
  cost: number;
  realized: number;
}

const KEEP_TRADES = 200;
const KEEP_SECONDS = 3700;

export const remaining = (o: OrderRec) => o.quantity - o.filled;
export const isBot = (a: Account) => a.name.startsWith("sim:");

export class Exchange {
  books = new Map<string, OrderBook>();
  accounts = new Map<number, Account>();
  private byName = new Map<string, Account>();
  private positions = new Map<string, Position>();
  private orders = new Map<number, OrderRec>();
  // People keep their whole order history; bot orders are dropped once done,
  // or memory would grow by thousands of orders a minute.
  private history = new Map<number, OrderRec[]>();
  private basis = new Map<string, Basis>();
  trades = new Map<string, TradeRec[]>();
  bars = new Map<string, Bar[]>();
  private ids = { account: 0, order: 0, trade: 0 };

  clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  book(symbol: string): OrderBook {
    let b = this.books.get(symbol);
    if (!b) {
      b = new OrderBook();
      this.books.set(symbol, b);
    }
    return b;
  }

  // -- accounts -------------------------------------------------------------

  openAccount(name: string, cash = 0): Account {
    const a: Account = { id: ++this.ids.account, name, cash, reserved: 0 };
    this.accounts.set(a.id, a);
    this.byName.set(name, a);
    if (!isBot(a)) this.history.set(a.id, []);
    return a;
  }

  findAccount(name: string): Account | undefined {
    return this.byName.get(name);
  }

  getAccount(name: string): Account {
    const a = this.byName.get(name);
    if (!a) throw new ExchangeError(`no account named '${name}'`, 404);
    return a;
  }

  position(account: number, symbol: string): Position {
    const key = `${account}:${symbol}`;
    let p = this.positions.get(key);
    if (!p) {
      p = { quantity: 0, reserved: 0 };
      this.positions.set(key, p);
    }
    return p;
  }

  positionsOf(account: number): [string, Position][] {
    const prefix = `${account}:`;
    const out: [string, Position][] = [];
    for (const [k, p] of this.positions) if (k.startsWith(prefix)) out.push([k.slice(prefix.length), p]);
    return out;
  }

  basisOf(account: number, symbol: string): Basis | undefined {
    return this.basis.get(`${account}:${symbol}`);
  }

  ordersOf(account: number): OrderRec[] {
    return this.history.get(account) ?? [];
  }

  // -- orders ---------------------------------------------------------------

  placeOrder(name: string, symbol: string, side: Side, quantity: number,
             limit: number | null): { order: OrderRec; trades: TradeRec[] } {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new ExchangeError("quantity must be positive");
    if (limit !== null && limit <= 0) throw new ExchangeError("price must be positive");

    const account = this.getAccount(name);
    const book = this.book(symbol);
    const pos = this.position(account.id, symbol);
    const [reservedCents, reservedQty] = this.checkAndReserve(account, pos, book, symbol, side, quantity, limit);

    const order: OrderRec = {
      id: ++this.ids.order, account: account.id, symbol, side, quantity, filled: 0,
      limit, reservedCents, reservedQty, status: "open", t: this.clock(),
    };
    this.orders.set(order.id, order);
    this.history.get(account.id)?.push(order);

    const fills = book.submit(order.id, account.id, side, quantity, limit);
    const trades = fills.map((f) => this.settle(symbol, f));

    if (remaining(order) > 0 && limit === null) {
      this.release(order);
      order.status = "expired";
    }
    this.forgetIfDone(order);
    return { order, trades };
  }

  cancelOrder(id: number): OrderRec {
    const order = this.orders.get(id);
    if (!order) throw new ExchangeError(`no order ${id}`, 404);
    if (order.status === "filled" || order.status === "cancelled" || order.status === "expired") {
      throw new ExchangeError(`order ${id} is already ${order.status}`);
    }
    this.book(order.symbol).cancel(id);
    this.release(order);
    order.status = "cancelled";
    this.orders.delete(id);
    return order;
  }

  private checkAndReserve(account: Account, pos: Position, book: OrderBook, symbol: string,
                          side: Side, quantity: number, limit: number | null): [number, number] {
    if (side === "sell") {
      const available = pos.quantity - pos.reserved;
      if (available < quantity) {
        throw new ExchangeError(
          `${account.name} has ${available} sellable ${symbol} but tried to sell ${quantity}`, 422);
      }
      pos.reserved += quantity;
      return [0, quantity];
    }
    const available = account.cash - account.reserved;
    if (limit !== null) {
      const cost = limit * quantity;
      if (available < cost) {
        throw new ExchangeError(
          `${account.name} has ${dollars(available)} available but the order needs ${dollars(cost)}`, 422);
      }
      account.reserved += cost;
      return [cost, 0];
    }
    const [cost, fillable] = book.costToFill("buy", quantity);
    if (fillable === 0) throw new ExchangeError("no sellers available for a market buy");
    if (available < cost) {
      throw new ExchangeError(
        `${account.name} has ${dollars(available)} available but filling ${fillable} at market would cost ${dollars(cost)}`, 422);
    }
    return [0, 0];
  }

  private settle(symbol: string, f: Fill): TradeRec {
    const buy = this.orders.get(f.buyOrderId)!;
    const sell = this.orders.get(f.sellOrderId)!;
    const buyer = this.accounts.get(buy.account)!;
    const seller = this.accounts.get(sell.account)!;
    const notional = f.price * f.quantity;

    if (buy.limit !== null) {
      const released = buy.limit * f.quantity;
      buyer.reserved -= released;
      buy.reservedCents -= released;
    }
    buyer.cash -= notional;
    this.position(buyer.id, symbol).quantity += f.quantity;

    const sp = this.position(seller.id, symbol);
    sp.quantity -= f.quantity;
    sp.reserved -= f.quantity;
    sell.reservedQty -= f.quantity;
    seller.cash += notional;

    for (const o of [buy, sell]) {
      o.filled += f.quantity;
      o.status = remaining(o) === 0 ? "filled" : "partially_filled";
    }

    const t: TradeRec = {
      id: ++this.ids.trade, symbol, price: f.price, quantity: f.quantity,
      buyOrderId: buy.id, sellOrderId: sell.id, buyer: buyer.id, seller: seller.id, t: this.clock(),
    };
    if (buyer.id !== seller.id) {
      this.trackBasis(buyer, symbol, f.price, f.quantity, true);
      this.trackBasis(seller, symbol, f.price, f.quantity, false);
    }
    this.record(t);
    // The resting side is finished with once filled; the incoming side is
    // handled by placeOrder after every fill has settled.
    if (f.buyOrderId < f.sellOrderId) this.forgetIfDone(buy);
    else this.forgetIfDone(sell);
    return t;
  }

  /** Average-cost P&L, same method as backend/app/pnl.py, kept as trades land. */
  private trackBasis(a: Account, symbol: string, price: number, qty: number, bought: boolean) {
    if (isBot(a)) return;
    const key = `${a.id}:${symbol}`;
    let b = this.basis.get(key);
    if (!b) {
      b = { quantity: 0, cost: 0, realized: 0 };
      this.basis.set(key, b);
    }
    if (bought) {
      b.quantity += qty;
      b.cost += price * qty;
      return;
    }
    if (b.quantity <= 0) return;
    const q = Math.min(qty, b.quantity);
    const avg = b.cost / b.quantity;
    b.realized += Math.round(q * (price - avg));
    b.cost -= Math.round(q * avg);
    b.quantity -= q;
  }

  private record(t: TradeRec) {
    let list = this.trades.get(t.symbol);
    if (!list) {
      list = [];
      this.trades.set(t.symbol, list);
    }
    list.push(t);
    if (list.length > KEEP_TRADES * 2) list.splice(0, list.length - KEEP_TRADES);

    let bars = this.bars.get(t.symbol);
    if (!bars) {
      bars = [];
      this.bars.set(t.symbol, bars);
    }
    const sec = Math.floor(t.t);
    const last = bars[bars.length - 1];
    if (last && last.t === sec) {
      last.high = Math.max(last.high, t.price);
      last.low = Math.min(last.low, t.price);
      last.close = t.price;
      last.volume += t.quantity;
    } else {
      bars.push({ t: sec, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.quantity });
      if (bars[0].t < sec - KEEP_SECONDS) bars.splice(0, bars.findIndex((b) => b.t >= sec - KEEP_SECONDS));
    }
  }

  private release(o: OrderRec) {
    const a = this.accounts.get(o.account)!;
    if (o.reservedCents) {
      a.reserved -= o.reservedCents;
      o.reservedCents = 0;
    }
    if (o.reservedQty) {
      this.position(o.account, o.symbol).reserved -= o.reservedQty;
      o.reservedQty = 0;
    }
  }

  private forgetIfDone(o: OrderRec) {
    if (o.status === "filled" || o.status === "expired" || o.status === "cancelled") this.orders.delete(o.id);
  }
}

/** 9950 -> "99.50", same as backend/app/money.py. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export const dollars = (cents: number) => (cents < 0 ? "-$" : "$") + formatCents(Math.abs(cents));
