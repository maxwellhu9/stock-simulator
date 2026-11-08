// The Challenge page: buy a block of shares against the clock, then see how
// that compares with simple strategies playing the same round.
//
// Every round is its own small market in the browser, separate from the main
// one, so it can't touch anyone's portfolio and the bots can replay it
// hundreds of times in a moment.

import { Exchange, ExchangeError, type OrderRec, formatCents, remaining } from "./exchange";
import { BAD_NEWS, GOOD_NEWS, MarketSim } from "./market";
import type { Book, Money } from "../types";

export const SYMBOL = "AAPL";
export const TARGET = 5000;
export const SECONDS = 60;
const START_PRICE = 23150;
const WARMUP_TICKS = 60;
const YOU = "you";
// Shares not bought in time still have to be bought, in a rush. Without a
// penalty, doing nothing wins any round with bad news. 5% is more than any
// event moves the price, so skipping shares can never pay.
const LATE_PENALTY = 1.05;

export interface ChallengeEvent {
  at: number; // seconds into the round
  kind: "good" | "bad" | "flash";
  headline: string;
  move: number; // change to what the stock is worth; 0 for a flash crash
}

export interface Outcome {
  filled: number;
  avgPrice: number; // cents; 0 if nothing was bought
  /** Cents paid beyond the starting price. Unbought shares cost the final price plus 5%. */
  extraCost: number;
}

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const money = (cents: number): Money => ({ cents, display: formatCents(cents) });

export function pickEvent(): ChallengeEvent {
  const at = 15 + Math.floor(Math.random() * 26);
  const roll = Math.random();
  if (roll < 1 / 3) return { at, kind: "flash", headline: "Market makers pull their quotes", move: 0 };
  const good = roll < 2 / 3;
  const [headline, lo, hi] = pick(good ? GOOD_NEWS : BAD_NEWS);
  const size = lo + Math.random() * (hi - lo);
  return { at, kind: good ? "good" : "bad", headline, move: good ? size : -size };
}

export class Round {
  second = 0;
  fired = false;
  arrival: number;
  private now = Date.now() / 1000 - WARMUP_TICKS;
  private ex = new Exchange(() => this.now);
  private sim: MarketSim;
  private accountId: number;
  private bidOrder: OrderRec | null = null;
  private event: ChallengeEvent;

  constructor(event: ChallengeEvent) {
    this.event = event;
    this.sim = new MarketSim(this.ex, { [SYMBOL]: START_PRICE }, () => this.now);
    this.sim.randomNews = false; // the round's one event is the only surprise
    for (let i = 0; i < WARMUP_TICKS; i++) {
      this.sim.tick(SYMBOL);
      this.now += 1;
    }
    this.accountId = this.ex.openAccount(YOU, 10_000_000_00).id;
    this.arrival = this.mid();
  }

  private mid(): number {
    const b = this.ex.book(SYMBOL);
    return b.bestBid !== null && b.bestAsk !== null
      ? Math.trunc((b.bestBid + b.bestAsk) / 2)
      : this.sim.last[SYMBOL];
  }

  get filled(): number {
    return this.ex.fillsOf(this.accountId).reduce((n, t) => n + t.quantity, 0);
  }

  get notional(): number {
    return this.ex.fillsOf(this.accountId).reduce((n, t) => n + t.price * t.quantity, 0);
  }

  get need(): number {
    return TARGET - this.filled;
  }

  get last(): number {
    return this.sim.last[SYMBOL];
  }

  get restingBid(): number {
    return this.bidOrder && (this.bidOrder.status === "open" || this.bidOrder.status === "partially_filled")
      ? remaining(this.bidOrder)
      : 0;
  }

  get over(): boolean {
    return this.second >= SECONDS || this.need <= 0;
  }

  /** Buy now at whatever sellers are asking. Stops if the book runs out. */
  buy(quantity: number) {
    const q = Math.min(quantity, this.need);
    if (q <= 0) return;
    if (q + this.restingBid > this.need) this.cancelBid(); // never end up over target
    try {
      const { trades } = this.ex.placeOrder(YOU, SYMBOL, "buy", q, null);
      for (const t of trades) this.sim.recordTrade(SYMBOL, t.price);
    } catch (e) {
      if (!(e instanceof ExchangeError)) throw e; // no sellers right now
    }
  }

  /** Wait in line at the best bid instead of paying the ask. Replaces any earlier bid. */
  bid(quantity: number) {
    this.cancelBid();
    const q = Math.min(quantity, this.need);
    const price = this.ex.book(SYMBOL).bestBid;
    if (q <= 0 || price === null) return;
    this.bidOrder = this.ex.placeOrder(YOU, SYMBOL, "buy", q, price).order;
  }

  cancelBid() {
    if (this.restingBid > 0) this.ex.cancelOrder(this.bidOrder!.id);
    this.bidOrder = null;
  }

  /** Advance the market by one second. */
  step() {
    this.second += 1;
    this.now += 1;
    if (this.second === this.event.at) {
      this.fired = true;
      if (this.event.kind === "flash") {
        this.sim.startScenario("flash_crash", SYMBOL);
      } else {
        this.sim.fair[SYMBOL] = Math.trunc(this.sim.fair[SYMBOL] * (1 + this.event.move));
      }
    }
    this.sim.runDue();
    this.sim.tick(SYMBOL);
    if (this.need <= 0) this.cancelBid();
  }

  result(): Outcome {
    this.cancelBid();
    const filled = this.filled;
    return {
      filled,
      avgPrice: filled ? Math.round(this.notional / filled) : 0,
      extraCost: this.notional + Math.round((TARGET - filled) * this.last * LATE_PENALTY)
        - TARGET * this.arrival,
    };
  }

  /** Price so far: the last half minute before the round, then the round itself. */
  series() {
    return this.sim.history[SYMBOL].slice(-(30 + this.second)).map(([t, price]) => ({ t, v: price }));
  }

  get eventTime(): number | null {
    return this.fired ? this.now - (this.second - this.event.at) : null;
  }

  book(levels = 6): Book {
    const b = this.ex.book(SYMBOL);
    const lv = ([p, q]: [number, number]) => ({ price: money(p), quantity: q });
    return {
      symbol: SYMBOL,
      bids: b.depth("buy", levels).map(lv),
      asks: b.depth("sell", levels).map(lv),
      best_bid: b.bestBid === null ? null : money(b.bestBid),
      best_ask: b.bestAsk === null ? null : money(b.bestAsk),
      spread: b.spread === null ? null : money(b.spread),
    };
  }
}

// -- the bots -----------------------------------------------------------------

export type BotName = "even" | "patient" | "huge";

export const BOTS: { key: BotName; name: string; description: string }[] = [
  { key: "even", name: "Evenly split", description: "Buys a little every second" },
  { key: "patient", name: "Patient limit orders", description: "Waits at the bid, rushes the last 5 seconds" },
  { key: "huge", name: "One huge order", description: "Buys everything at once, at the start" },
];

function playBot(bot: BotName, event: ChallengeEvent): Outcome {
  const r = new Round(event);
  if (bot === "huge") r.buy(TARGET);
  for (let s = 0; s < SECONDS; s++) {
    if (bot === "even") {
      r.buy(Math.ceil((TARGET * (s + 1)) / SECONDS) - r.filled);
    } else if (bot === "patient") {
      const left = SECONDS - s;
      if (left <= 5) {
        r.cancelBid();
        r.buy(Math.ceil(r.need / left));
      } else {
        r.bid(Math.min(r.need, 500));
      }
    }
    r.step();
  }
  return r.result();
}

export interface BotStats {
  trials: number;
  extraCost: number; // mean
  low: number; // 10th percentile of extra cost
  high: number; // 90th percentile
  avgPrice: number;
  filled: number; // mean shares bought
}

function summarize(runs: Outcome[]): BotStats {
  const sorted = runs.map((r) => r.extraCost).sort((a, b) => a - b);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const bought = runs.filter((r) => r.filled > 0);
  return {
    trials: runs.length,
    extraCost: mean(sorted),
    low: sorted[Math.floor(sorted.length * 0.1)],
    high: sorted[Math.floor(sorted.length * 0.9)],
    avgPrice: bought.length ? mean(bought.map((r) => r.avgPrice)) : 0,
    filled: mean(runs.map((r) => r.filled)),
  };
}

/** Replays the same event many times per bot, yielding so the page stays responsive. */
export async function runTrials(
  event: ChallengeEvent, trials: number, onProgress?: (done: number) => void,
): Promise<Record<BotName, BotStats>> {
  const runs: Record<BotName, Outcome[]> = { even: [], patient: [], huge: [] };
  let started = performance.now();
  for (let i = 0; i < trials; i++) {
    for (const { key } of BOTS) runs[key].push(playBot(key, event));
    if (performance.now() - started > 24) {
      onProgress?.(i + 1);
      await new Promise((resolve) => setTimeout(resolve));
      started = performance.now();
    }
  }
  return { even: summarize(runs.even), patient: summarize(runs.patient), huge: summarize(runs.huge) };
}
