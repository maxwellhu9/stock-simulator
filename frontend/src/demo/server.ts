// Stands in for the FastAPI backend when the site is built as a static demo.
// Every function returns the same JSON shape its HTTP endpoint would, so the
// React views cannot tell the difference. Nothing is saved: a reload starts a
// fresh market.

import { ApiError } from "../apiError";
import type {
  Book,
  Candle,
  HistoryPoint,
  MarketEvent,
  Money,
  Order,
  PlaceOrderResult,
  Population,
  Portfolio,
  PositionOut,
  ScenarioInfo,
  ShockResult,
  Side,
  SimState,
  Trade,
} from "../types";
import { Exchange, ExchangeError, type OrderRec, type TradeRec, formatCents, remaining } from "./exchange";
import { MarketSim, SCENARIOS, type MarketEvent as SimEvent } from "./market";

const SYMBOLS = ["AAPL", "NVDA", "MSFT"];
const START_PRICES: Record<string, number> = { AAPL: 23150, NVDA: 18420, MSFT: 51075 };
const WARMUP_TICKS = 900; // fifteen minutes of history, so the charts are never empty

export type SocketMessage =
  | { type: "snapshot"; book: Book; trades: Trade[] }
  | { type: "update"; book: Book; trades: Trade[]; last: Money | null };

// -- the running market -------------------------------------------------------

let virtualNow: number | null = null;
const clock = () => virtualNow ?? Date.now() / 1000;

let ex: Exchange;
let sim: MarketSim;
let speed = 1;
let paused = false;
const watchers = new Map<string, Set<(m: SocketMessage) => void>>();
const published: Record<string, number> = {};

function boot() {
  if (sim) return;
  ex = new Exchange(clock);
  sim = new MarketSim(ex, START_PRICES, clock);
  // Run the first ten minutes instantly with backdated timestamps.
  const start = Date.now() / 1000 - WARMUP_TICKS;
  for (let i = 0; i < WARMUP_TICKS; i++) {
    virtualNow = start + i;
    for (const s of SYMBOLS) sim.tick(s);
  }
  virtualNow = null;
  for (const s of SYMBOLS) published[s] = lastTradeId(s);
  loop();
}

function loop() {
  let next = performance.now();
  const step = () => {
    if (!paused) {
      try {
        sim.runDue();
        for (const s of SYMBOLS) {
          sim.tick(s);
          publish(s);
        }
      } catch (e) {
        console.error("[market]", e);
      }
    }
    next += 1000 / speed;
    const delay = next - performance.now();
    if (delay < 0) next = performance.now();
    setTimeout(step, Math.max(0, delay));
  };
  setTimeout(step, 1000 / speed);
}

function lastTradeId(symbol: string): number {
  const list = ex.trades.get(symbol);
  return list?.length ? list[list.length - 1].id : 0;
}

function publish(symbol: string) {
  const subs = watchers.get(symbol);
  const since = published[symbol] ?? 0;
  published[symbol] = lastTradeId(symbol);
  if (!subs?.size) return;
  const fresh = (ex.trades.get(symbol) ?? []).filter((t) => t.id > since).slice(-40);
  const msg: SocketMessage = {
    type: "update", book: bookOut(symbol, 8), trades: fresh.map(tradeOut), last: money(sim.last[symbol]),
  };
  subs.forEach((cb) => cb(msg));
}

/** The demo's WebSocket: a snapshot now, then an update every tick. */
export function subscribe(symbol: string, cb: (m: SocketMessage) => void): () => void {
  boot();
  let subs = watchers.get(symbol);
  if (!subs) {
    subs = new Set();
    watchers.set(symbol, subs);
  }
  subs.add(cb);
  const recent = (ex.trades.get(symbol) ?? []).slice(-20).reverse();
  cb({ type: "snapshot", book: bookOut(symbol, 8), trades: recent.map(tradeOut) });
  return () => {
    subs.delete(cb);
  };
}

// -- shaping responses --------------------------------------------------------

const money = (cents: number): Money => ({ cents, display: formatCents(cents) });
const iso = (t: number) => new Date(t * 1000).toISOString();

function label(accountId: number): string {
  const name = ex.accounts.get(accountId)?.name ?? "?";
  if (!name.startsWith("sim:")) return name;
  const kind = name.split(":").pop()!.replace(/_\d+$/, "");
  return kind === "shock" ? "big order" : kind;
}

function tradeOut(t: TradeRec): Trade {
  return {
    id: t.id, symbol: t.symbol, price: money(t.price), quantity: t.quantity,
    notional: money(t.price * t.quantity), buy_order_id: t.buyOrderId, sell_order_id: t.sellOrderId,
    created_at: iso(t.t), buyer: label(t.buyer), seller: label(t.seller),
  };
}

function orderOut(o: OrderRec): Order {
  return {
    id: o.id, account_id: o.account, symbol: o.symbol, side: o.side, quantity: o.quantity,
    filled_quantity: o.filled, remaining: remaining(o),
    limit_price: o.limit === null ? null : money(o.limit), status: o.status, created_at: iso(o.t),
  };
}

function bookOut(symbol: string, levels: number): Book {
  const b = ex.book(symbol);
  const lv = ([p, q]: [number, number]) => ({ price: money(p), quantity: q });
  return {
    symbol,
    bids: b.depth("buy", levels).map(lv),
    asks: b.depth("sell", levels).map(lv),
    best_bid: b.bestBid === null ? null : money(b.bestBid),
    best_ask: b.bestAsk === null ? null : money(b.bestAsk),
    spread: b.spread === null ? null : money(b.spread),
  };
}

function portfolioOut(name: string): Portfolio {
  const a = ex.getAccount(name);
  const positions: PositionOut[] = [];
  let held = 0;
  let unrealized = 0;
  let realized = 0;
  for (const [symbol, p] of ex.positionsOf(a.id)) {
    const b = ex.basisOf(a.id, symbol);
    realized += b?.realized ?? 0;
    if (!p.quantity && !p.reserved) continue;
    const po: PositionOut = {
      symbol, quantity: p.quantity, reserved: p.reserved, available: p.quantity - p.reserved,
      avg_cost: null, last_price: null, market_value: null, unrealized_pnl: null,
    };
    const last = sim.last[symbol];
    if (last !== undefined) {
      const value = last * p.quantity;
      po.last_price = money(last);
      po.market_value = money(value);
      held += value;
      if (b && b.quantity) {
        po.avg_cost = money(Math.round(b.cost / b.quantity));
        po.unrealized_pnl = money(value - b.cost);
        unrealized += value - b.cost;
      }
    }
    positions.push(po);
  }
  return {
    name: a.name, cash: money(a.cash), reserved: money(a.reserved), available: money(a.cash - a.reserved),
    positions, positions_value: money(held), total_value: money(a.cash + held),
    unrealized_pnl: money(unrealized), realized_pnl: money(realized),
  };
}

function simState(): SimState {
  return {
    population: { ...sim.population }, sentiment: sim.sentiment, speed, paused,
    random_news: sim.randomNews,
    scenario: sim.scenario && {
      key: sim.scenario.key, name: sim.scenario.name, ends_in: Math.max(0, sim.scenario.endsAt - clock()),
    },
    symbols: SYMBOLS.map((s) => ({ symbol: s, last: money(sim.last[s]), fair: money(sim.fair[s]) })),
  };
}

const eventOut = (e: SimEvent): MarketEvent => ({
  t: e.t, symbol: e.symbol, kind: e.kind, headline: e.headline, impact_pct: e.impact * 100,
});

/** "99.50" -> 9950, without going through a float. */
function toCents(s: string): number {
  const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(s);
  if (!m) throw new ApiError(422, `not a valid money amount: '${s}'`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Run one call like a request: boot if needed, turn domain errors into HTTP ones. */
async function handle<T>(fn: () => T): Promise<T> {
  boot();
  try {
    return fn();
  } catch (e) {
    if (e instanceof ExchangeError) throw new ApiError(e.status, e.message);
    throw e;
  }
}

// -- the API ------------------------------------------------------------------

export const demoApi = {
  createAccount: (name: string, initial_cash: string) => handle(() => {
    if (ex.findAccount(name)) throw new ApiError(409, `account '${name}' already exists`);
    ex.openAccount(name, toCents(initial_cash));
    return portfolioOut(name);
  }),
  // Nothing survives a reload, so a remembered name simply starts over.
  portfolio: (name: string) => handle(() => {
    if (!ex.findAccount(name)) ex.openAccount(name, 100_000_00);
    return portfolioOut(name);
  }),

  placeOrder: (body: { account: string; symbol: string; side: Side; quantity: number; limit_price: string | null }) =>
    handle((): PlaceOrderResult => {
      const symbol = body.symbol.toUpperCase();
      const limit = body.limit_price === null ? null : toCents(body.limit_price);
      const { order, trades } = ex.placeOrder(body.account, symbol, body.side, body.quantity, limit);
      for (const t of trades) sim.recordTrade(symbol, t.price);
      publish(symbol);
      return { order: orderOut(order), trades: trades.map(tradeOut) };
    }),
  cancelOrder: (id: number) => handle(() => {
    const o = ex.cancelOrder(id);
    publish(o.symbol);
    return orderOut(o);
  }),
  orders: (account: string) => handle(() =>
    ex.ordersOf(ex.getAccount(account).id).slice(-100).reverse().map(orderOut)),

  book: (symbol: string, levels = 6) => handle(() => bookOut(symbol, levels)),
  trades: (symbol: string, limit = 20) => handle(() =>
    (ex.trades.get(symbol) ?? []).slice(-limit).reverse().map(tradeOut)),
  candles: (symbol: string, seconds: number, limit: number) => handle((): Candle[] => {
    const bars = ex.bars.get(symbol) ?? [];
    const cutoff = clock() - seconds * limit;
    const out: Candle[] = [];
    for (let i = bars.length - 1; i >= 0 && bars[i].t >= Math.floor(cutoff); i--) {
      const b = bars[i];
      const start = Math.floor(b.t / seconds) * seconds;
      const c = out[out.length - 1];
      if (c && c.t === start) {
        // Walking backwards, so this bar came BEFORE what is already merged.
        c.open = b.open;
        c.high = Math.max(c.high, b.high);
        c.low = Math.min(c.low, b.low);
        c.volume += b.volume;
      } else {
        out.push({ ...b, t: start });
      }
    }
    return out.reverse().slice(-limit);
  }),

  symbols: () => handle(() => SYMBOLS.map((symbol) => ({ symbol, mid: money(sim.last[symbol]) }))),

  sim: () => handle(simState),
  simHistory: (symbol: string) => handle((): HistoryPoint[] =>
    (sim.history[symbol] ?? []).map(([t, price, fair]) => ({ t: Math.round(t * 100) / 100, price, fair }))),
  setPopulation: (p: Population) => handle(() => {
    sim.setPopulation({
      value: clamp(p.value, 0, 30), momentum: clamp(p.momentum, 0, 30),
      noise: clamp(p.noise, 0, 30), maker: clamp(p.maker, 0, 12),
    });
    return simState();
  }),
  setControls: (c: { sentiment?: number; speed?: number; paused?: boolean; random_news?: boolean }) => handle(() => {
    if (c.sentiment !== undefined) sim.sentiment = clamp(c.sentiment, -1, 1);
    if (c.speed !== undefined) speed = clamp(c.speed, 0.25, 4);
    if (c.paused !== undefined) paused = c.paused;
    if (c.random_news !== undefined) sim.randomNews = c.random_news;
    return simState();
  }),
  events: (symbol?: string) => handle(() =>
    [...sim.events].reverse().filter((e) => !symbol || !e.symbol || e.symbol === symbol).slice(0, 20).map(eventOut)),
  news: (symbol: string, good: boolean) => handle(() => eventOut(sim.news(symbol, good))),
  scenarios: () => handle((): ScenarioInfo[] =>
    SCENARIOS.map((s) => ({ key: s.key, name: s.name, description: s.description, seconds: s.duration }))),
  runScenario: (key: string, symbol: string) => handle(() => {
    if (key === "calm") sim.calm();
    else sim.startScenario(key, symbol);
    publish(symbol);
    return simState();
  }),
  shock: (symbol: string, side: Side, quantity: number) => handle((): ShockResult => {
    const r = sim.shock(symbol, side, quantity);
    publish(symbol);
    return {
      side, requested: r.requested, filled: r.filled, fill_rate: r.requested ? r.filled / r.requested : 0,
      price_before: money(r.midBefore), avg_fill: money(r.avgFill),
      slippage_pct: r.midBefore ? ((r.avgFill - r.midBefore) / r.midBefore) * 100 : 0,
      orders_hit: r.ordersHit,
    };
  }),
};
