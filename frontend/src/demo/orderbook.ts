// A TypeScript port of backend/app/orderbook.py, for the in-browser demo.
// Same rule: price-time priority, and trades print at the resting order's price.

export type Side = "buy" | "sell";

export interface BookOrder {
  id: number;
  account: number;
  side: Side;
  quantity: number;
  price: number | null; // null = market order
  remaining: number;
}

export interface Fill {
  price: number;
  quantity: number;
  buyOrderId: number;
  sellOrderId: number;
}

/** Insert into an ascending array, keeping it sorted. */
function insertSorted(arr: number[], x: number) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, x);
}

export class OrderBook {
  private bids = new Map<number, BookOrder[]>();
  private asks = new Map<number, BookOrder[]>();
  // Both ascending: best bid is the last element, best ask the first.
  private bidPrices: number[] = [];
  private askPrices: number[] = [];
  private byId = new Map<number, BookOrder>();

  get bestBid(): number | null {
    return this.bidPrices.length ? this.bidPrices[this.bidPrices.length - 1] : null;
  }

  get bestAsk(): number | null {
    return this.askPrices.length ? this.askPrices[0] : null;
  }

  get spread(): number | null {
    const b = this.bestBid;
    const a = this.bestAsk;
    return b === null || a === null ? null : a - b;
  }

  /** Top N levels as [price, total quantity], best first. */
  depth(side: Side, levels = 5): [number, number][] {
    const prices = side === "buy" ? [...this.bidPrices].reverse() : this.askPrices;
    const book = side === "buy" ? this.bids : this.asks;
    return prices.slice(0, levels).map((p) => [p, book.get(p)!.reduce((s, o) => s + o.remaining, 0)]);
  }

  /** What a market order would cost: [total cents, quantity fillable]. */
  costToFill(side: Side, quantity: number): [number, number] {
    const book = side === "buy" ? this.asks : this.bids;
    const prices = side === "buy" ? this.askPrices : [...this.bidPrices].reverse();
    let total = 0;
    let left = quantity;
    for (const price of prices) {
      if (left <= 0) break;
      const available = book.get(price)!.reduce((s, o) => s + o.remaining, 0);
      const take = Math.min(left, available);
      total += take * price;
      left -= take;
    }
    return [total, quantity - left];
  }

  submit(id: number, account: number, side: Side, quantity: number, price: number | null): Fill[] {
    const order: BookOrder = { id, account, side, quantity, price, remaining: quantity };
    this.byId.set(id, order);
    const fills = this.match(order);
    // A market order that runs out of book is abandoned, never rested.
    if (order.remaining > 0 && price !== null) this.rest(order);
    else this.byId.delete(id);
    return fills;
  }

  cancel(id: number): boolean {
    const order = this.byId.get(id);
    if (!order || order.remaining === 0 || order.price === null) return false;
    const book = order.side === "buy" ? this.bids : this.asks;
    const prices = order.side === "buy" ? this.bidPrices : this.askPrices;
    const queue = book.get(order.price);
    const i = queue ? queue.indexOf(order) : -1;
    if (!queue || i < 0) return false;
    queue.splice(i, 1);
    if (!queue.length) {
      book.delete(order.price);
      prices.splice(prices.indexOf(order.price), 1);
    }
    order.remaining = 0;
    this.byId.delete(id);
    return true;
  }

  private match(incoming: BookOrder): Fill[] {
    const fills: Fill[] = [];
    const buying = incoming.side === "buy";
    const book = buying ? this.asks : this.bids;
    const prices = buying ? this.askPrices : this.bidPrices;

    while (incoming.remaining > 0 && prices.length) {
      const level = buying ? prices[0] : prices[prices.length - 1];
      if (incoming.price !== null && (buying ? incoming.price < level : incoming.price > level)) break;

      const queue = book.get(level)!;
      while (queue.length && incoming.remaining > 0) {
        const resting = queue[0];
        const qty = Math.min(incoming.remaining, resting.remaining);
        incoming.remaining -= qty;
        resting.remaining -= qty;
        fills.push({
          price: level,
          quantity: qty,
          buyOrderId: buying ? incoming.id : resting.id,
          sellOrderId: buying ? resting.id : incoming.id,
        });
        if (resting.remaining === 0) {
          queue.shift();
          this.byId.delete(resting.id);
        }
      }
      if (!queue.length) {
        book.delete(level);
        if (buying) prices.shift();
        else prices.pop();
      }
    }
    return fills;
  }

  private rest(order: BookOrder) {
    const book = order.side === "buy" ? this.bids : this.asks;
    const prices = order.side === "buy" ? this.bidPrices : this.askPrices;
    let queue = book.get(order.price!);
    if (!queue) {
      queue = [];
      book.set(order.price!, queue);
      insertSorted(prices, order.price!);
    }
    queue.push(order);
  }
}
