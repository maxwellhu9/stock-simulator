// A TypeScript port of backend/app/market_sim.py and scenarios.py.

import {
  type Agent,
  DEFAULT_POPULATION,
  type Intent,
  MarketMaker,
  type MarketState,
  type Population,
  buildPopulation,
  gauss,
} from "./agents";
import { type Exchange, ExchangeError, type TradeRec, remaining } from "./exchange";
import type { Side } from "./orderbook";

const PREFIX = "sim";
const AGENT_CASH = 2_000_000_00;
const AGENT_SHARES = 20_000;
const FAIR_VOL = 0.0007;
const FAIR_PERSIST = 0.95;
const ACT_FRACTION = 0.55;
const ORDER_TTL = 8;
const HISTORY = 900;
const NEWS_CHANCE = 1 / 150;

export interface MarketEvent {
  t: number;
  symbol: string | null;
  kind: "good" | "bad" | "scenario";
  headline: string;
  impact: number;
}

export interface ShockResult {
  requested: number;
  filled: number;
  midBefore: number;
  avgFill: number;
  ordersHit: number;
}

// -- news ---------------------------------------------------------------------

const GOOD_NEWS: [string, number, number][] = [
  ["Earnings beat expectations", 0.02, 0.04],
  ["New product launch gets strong early reviews", 0.012, 0.025],
  ["Analysts upgrade the stock", 0.01, 0.02],
  ["Wins a major long-term contract", 0.018, 0.035],
  ["Announces a large share buyback", 0.01, 0.02],
];
const BAD_NEWS: [string, number, number][] = [
  ["Earnings miss expectations", 0.025, 0.045],
  ["CEO steps down unexpectedly", 0.02, 0.035],
  ["Regulators open an investigation", 0.02, 0.04],
  ["Announces a product recall", 0.015, 0.03],
  ["Analysts downgrade the stock", 0.01, 0.02],
];

function drawNews(good: boolean, avoid: Set<string>): [string, number] {
  const pool = good ? GOOD_NEWS : BAD_NEWS;
  const fresh = pool.filter((n) => !avoid.has(n[0]));
  const [headline, lo, hi] = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))];
  const move = lo + Math.random() * (hi - lo);
  return [headline, good ? move : -move];
}

// -- scenarios ----------------------------------------------------------------

type Run = (sim: MarketSim, symbol: string) => void;
interface Step { after: number; run: Run; log?: string }
export interface Scenario { key: string; name: string; description: string; duration: number; steps: Step[] }

const crowd = (kw: Partial<Population>): Run => (sim) => sim.setPopulation({ ...sim.population, ...kw });
const mood = (x: number): Run => (sim) => { sim.sentiment = x; };
const news = (good: boolean): Run => (sim, s) => { sim.news(s, good); };
// Sells down to `floor` below the market, so it prints far below the last
// price once the bids are gone -- which is what a flash crash actually is.
const sell = (qty: number, floor: number): Run => (sim, s) => { sim.shock(s, "sell", qty, floor); };

export const SCENARIOS: Scenario[] = [
  {
    key: "bubble", name: "Bubble", duration: 60,
    description: "Good news, then the crowd fills with trend-chasers and everyone gets optimistic.",
    steps: [
      { after: 0, run: news(true) },
      { after: 0, run: crowd({ value: 2, momentum: 20 }), log: "Trend-chasers pour in" },
      { after: 0, run: mood(0.7) },
    ],
  },
  {
    key: "flash_crash", name: "Flash crash", duration: 15,
    description: "Market makers pull out, then a huge seller hits the empty book.",
    steps: [
      { after: 0, run: crowd({ maker: 0 }), log: "Market makers pull their quotes" },
      { after: 2, run: sell(3000, 0.06), log: "A huge seller hits the book" },
    ],
  },
  {
    key: "panic", name: "Panic", duration: 45,
    description: "Bad news, the mood sours, and trend-chasers pile into the drop.",
    steps: [
      { after: 0, run: news(false) },
      { after: 0, run: mood(-0.7) },
      { after: 1, run: crowd({ momentum: 14 }), log: "Sellers start piling on" },
    ],
  },
];

const accountName = (symbol: string, agent: string) => `${PREFIX}:${symbol}:${agent}`;

// -- the market ---------------------------------------------------------------

export class MarketSim {
  fair: Record<string, number>;
  last: Record<string, number>;
  population: Population = { ...DEFAULT_POPULATION };
  sentiment = 0;
  agents: Record<string, Agent[]> = {};
  history: Record<string, [number, number, number][]> = {};
  events: MarketEvent[] = [];
  randomNews = true;
  scenario: { key: string; name: string; endsAt: number } | null = null;
  private plan: [number, Step, string][] = [];
  private restore: [Population, number] | null = null;
  private ticks: Record<string, number> = {};
  private working: Record<string, [number, number][]> = {};
  private drift: Record<string, number> = {};

  private ex: Exchange;
  private clock: () => number;

  constructor(ex: Exchange, prices: Record<string, number>, clock: () => number) {
    this.ex = ex;
    this.clock = clock;
    this.fair = { ...prices };
    this.last = { ...prices };
    for (const s of Object.keys(prices)) {
      this.agents[s] = buildPopulation(this.population);
      this.history[s] = [];
      this.ticks[s] = 0;
      this.working[s] = [];
      this.drift[s] = 0;
    }
    this.ensureAccounts();
  }

  get symbols() {
    return Object.keys(this.fair);
  }

  ensureAccounts() {
    for (const [symbol, agents] of Object.entries(this.agents)) {
      for (const agent of agents) {
        const name = accountName(symbol, agent.name);
        const a = this.ex.findAccount(name) ?? this.ex.openAccount(name, AGENT_CASH);
        if (a.cash - a.reserved < AGENT_CASH / 4) a.cash += AGENT_CASH;
        const pos = this.ex.position(a.id, symbol);
        if (pos.quantity - pos.reserved < AGENT_SHARES / 4) pos.quantity += AGENT_SHARES;
      }
    }
  }

  /** Replace the crowd, pulling the old crowd's orders first. */
  setPopulation(pop: Population) {
    for (const s of this.symbols) {
      for (const [id] of this.working[s]) this.tryCancel(id);
      for (const a of this.agents[s]) if (a instanceof MarketMaker) a.resting.forEach((id) => this.tryCancel(id));
      this.working[s] = [];
    }
    this.population = pop;
    for (const s of this.symbols) this.agents[s] = buildPopulation(pop);
    this.ensureAccounts();
  }

  private observe(symbol: string): MarketState {
    const book = this.ex.book(symbol);
    return {
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      last: this.last[symbol],
      tickPrices: this.history[symbol].slice(-12).map((h) => h[1]),
    };
  }

  tick(symbol: string) {
    this.ticks[symbol] += 1;
    this.expire(symbol);
    let state = this.observe(symbol);

    this.driftFair(symbol);
    if (this.randomNews && !this.scenario && Math.random() < NEWS_CHANCE) this.news(symbol);

    const agents = this.agents[symbol];
    // Makers requote first, so nobody trades against a book with no makers in it.
    for (const maker of agents) {
      if (!(maker instanceof MarketMaker)) continue;
      maker.resting.forEach((id) => this.tryCancel(id));
      maker.resting = [];
      maker.inventory = this.inventory(symbol, maker.name);
      for (const intent of maker.act(state)) this.submit(symbol, maker, intent);
      state = this.observe(symbol);
    }

    const others = agents.filter((a) => !(a instanceof MarketMaker) && Math.random() < ACT_FRACTION);
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [others[i], others[j]] = [others[j], others[i]];
    }
    for (const agent of others) {
      for (const intent of agent.act(state, this.fair[symbol])) {
        for (const t of this.submit(symbol, agent, intent)) this.recordTrade(symbol, t.price);
        state = this.observe(symbol);
      }
    }

    const h = this.history[symbol];
    h.push([this.clock(), this.last[symbol], this.fair[symbol]]);
    if (h.length > HISTORY) h.shift();
  }

  // -- news and scenarios -----------------------------------------------------

  news(symbol: string, good?: boolean): MarketEvent {
    const g = good ?? Math.random() < 0.5;
    const recent = new Set(this.events.slice(-12).filter((e) => e.symbol === symbol).map((e) => e.headline));
    const [headline, move] = drawNews(g, recent);
    this.fair[symbol] = Math.max(100, Math.trunc(this.fair[symbol] * (1 + move)));
    const e: MarketEvent = { t: this.clock(), symbol, kind: g ? "good" : "bad", headline, impact: move };
    this.pushEvent(e);
    return e;
  }

  startScenario(key: string, symbol: string) {
    const sc = SCENARIOS.find((s) => s.key === key);
    if (!sc) throw new ExchangeError(`no scenario '${key}'`, 404);
    const now = this.clock();
    if (!this.restore) this.restore = [this.population, this.sentiment];
    this.scenario = { key: sc.key, name: sc.name, endsAt: now + sc.duration };
    this.plan = sc.steps.map((st): [number, Step, string] => [now + st.after, st, symbol])
      .sort((a, b) => a[0] - b[0]);
    this.pushEvent({ t: now, symbol: null, kind: "scenario", headline: `${sc.name} begins`, impact: 0 });
    this.runDue();
  }

  calm() {
    this.plan = [];
    this.scenario = null;
    const [pop, mood] = this.restore ?? [{ ...DEFAULT_POPULATION }, 0];
    this.restore = null;
    this.sentiment = mood;
    this.setPopulation(pop);
    this.pushEvent({ t: this.clock(), symbol: null, kind: "scenario", headline: "Things calm down", impact: 0 });
  }

  runDue() {
    const now = this.clock();
    while (this.plan.length && this.plan[0][0] <= now) {
      const [, step, symbol] = this.plan.shift()!;
      step.run(this, symbol);
      if (step.log) this.pushEvent({ t: now, symbol, kind: "scenario", headline: step.log, impact: 0 });
    }
    if (this.scenario && now >= this.scenario.endsAt && !this.plan.length) this.calm();
  }

  /** A large order. `floor` = 0 is a market order; otherwise a limit that far through the price. */
  shock(symbol: string, side: Side, quantity: number, floor = 0): ShockResult {
    const name = accountName(symbol, "shock");
    const a = this.ex.findAccount(name) ?? this.ex.openAccount(name, AGENT_CASH * 10);
    const pos = this.ex.position(a.id, symbol);
    if (pos.quantity - pos.reserved < quantity) pos.quantity += quantity * 4;
    if (a.cash - a.reserved < AGENT_CASH) a.cash += AGENT_CASH * 10;

    const book = this.ex.book(symbol);
    const midBefore = book.bestBid !== null && book.bestAsk !== null
      ? Math.trunc((book.bestBid + book.bestAsk) / 2) : this.last[symbol];

    let trades: TradeRec[] = [];
    try {
      const limit = floor ? Math.trunc(midBefore * (side === "sell" ? 1 - floor : 1 + floor)) : null;
      const r = this.ex.placeOrder(name, symbol, side, quantity, limit);
      trades = r.trades;
      // Whatever does not fill rests for a few seconds, then is pulled like any bot order.
      if (remaining(r.order) > 0 && limit !== null) this.working[symbol].push([r.order.id, this.ticks[symbol]]);
    } catch (e) {
      if (!(e instanceof ExchangeError)) throw e;
    }
    const filled = trades.reduce((s, t) => s + t.quantity, 0);
    const notional = trades.reduce((s, t) => s + t.price * t.quantity, 0);
    for (const t of trades) this.recordTrade(symbol, t.price);
    return {
      requested: quantity, filled, midBefore,
      avgFill: filled ? Math.trunc(notional / filled) : midBefore,
      ordersHit: trades.length,
    };
  }

  recordTrade(symbol: string, price: number) {
    this.last[symbol] = price;
  }

  // -- internals --------------------------------------------------------------

  private pushEvent(e: MarketEvent) {
    this.events.push(e);
    if (this.events.length > 60) this.events.shift();
  }

  private submit(symbol: string, agent: Agent, intent: Intent): TradeRec[] {
    if (intent.price !== null && intent.price <= 0) return [];
    try {
      const { order, trades } = this.ex.placeOrder(
        accountName(symbol, agent.name), symbol, intent.side, intent.quantity, intent.price);
      if (remaining(order) > 0 && order.status !== "expired") {
        if (agent instanceof MarketMaker) agent.resting.push(order.id);
        else this.working[symbol].push([order.id, this.ticks[symbol]]);
      }
      agent.inventory += intent.side === "buy" ? order.filled : -order.filled;
      return trades;
    } catch (e) {
      if (e instanceof ExchangeError) return []; // out of cash or shares
      throw e;
    }
  }

  private tryCancel(id: number) {
    try {
      this.ex.cancelOrder(id);
    } catch {
      /* already filled or cancelled */
    }
  }

  private expire(symbol: string) {
    const now = this.ticks[symbol];
    this.working[symbol] = this.working[symbol].filter(([id, placed]) => {
      if (now - placed < ORDER_TTL) return true;
      this.tryCancel(id);
      return false;
    });
  }

  private inventory(symbol: string, agent: string): number {
    const a = this.ex.findAccount(accountName(symbol, agent));
    return a ? this.ex.position(a.id, symbol).quantity - AGENT_SHARES : 0;
  }

  /** Persistent drift: smooth tick to tick, wandering over minutes. */
  private driftFair(symbol: string) {
    const k = 1 - FAIR_PERSIST;
    const bias = this.sentiment * FAIR_VOL * 1.4 * k;
    this.drift[symbol] = FAIR_PERSIST * this.drift[symbol] + gauss(bias, FAIR_VOL * k);
    this.fair[symbol] = Math.max(100, Math.trunc(this.fair[symbol] * Math.exp(this.drift[symbol])));
  }
}
