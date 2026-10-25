// A TypeScript port of backend/app/agents.py. See that file for why each
// kind of trader behaves the way it does.

import type { Side } from "./orderbook";

export interface Intent {
  side: Side;
  quantity: number;
  price: number | null;
}

export interface MarketState {
  bestBid: number | null;
  bestAsk: number | null;
  last: number;
  tickPrices: number[];
}

export interface Population {
  value: number;
  momentum: number;
  noise: number;
  maker: number;
}

export const DEFAULT_POPULATION: Population = { value: 6, momentum: 5, noise: 8, maker: 2 };

const uniform = (a: number, b: number) => a + Math.random() * (b - a);
const randint = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const int = Math.trunc;

/** Normal sample via Box-Muller. */
export function gauss(mu: number, sigma: number): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mid(s: MarketState): number {
  return s.bestBid !== null && s.bestAsk !== null ? int((s.bestBid + s.bestAsk) / 2) : s.last;
}

export type Kind = "value" | "momentum" | "noise" | "maker";

export abstract class Agent {
  abstract kind: Kind;
  name: string;
  inventory = 0;

  constructor(name: string) {
    this.name = name;
  }

  abstract act(state: MarketState, fair: number): Intent[];
}

export class ValueTrader extends Agent {
  kind = "value" as const;
  bias: number;

  constructor(name: string, error = 0.008) {
    super(name);
    this.bias = gauss(0, error);
  }

  act(state: MarketState, fair: number): Intent[] {
    const myFair = int(fair * (1 + this.bias));
    const m = mid(state);
    const gap = myFair ? (myFair - m) / myFair : 0;

    // Close to fair: leave an order where the price would be a bargain.
    if (Math.abs(gap) < 0.002) {
      if (Math.random() > 0.8) return [];
      const size = Math.max(1, randint(80, 260));
      const margin = 0.003 + uniform(0, 0.009);
      return Math.random() < 0.5
        ? [{ side: "buy", quantity: size, price: int(myFair * (1 - margin)) }]
        : [{ side: "sell", quantity: size, price: int(myFair * (1 + margin)) }];
    }

    const size = Math.min(Math.max(1, int(Math.abs(gap) * 4000)), 300);
    const nudge = Math.max(1, int(m * 0.0006));
    if (gap > 0) return [{ side: "buy", quantity: size, price: Math.min(myFair, m + nudge) }];
    return [{ side: "sell", quantity: size, price: Math.max(myFair, m - nudge) }];
  }
}

export class MomentumTrader extends Agent {
  kind = "momentum" as const;
  threshold: number;
  lookback = randint(4, 10);
  maxPosition = randint(80, 200);

  constructor(name: string, threshold = 0.0006) {
    super(name);
    this.threshold = threshold * uniform(0.6, 1.6);
  }

  act(state: MarketState): Intent[] {
    const w = state.tickPrices.slice(-(this.lookback + 1));
    if (w.length < this.lookback + 1 || !w[0]) return [];
    if (state.bestAsk === null || state.bestBid === null) return [];
    const m = (w[w.length - 1] - w[0]) / w[0];

    if (Math.abs(m) < this.threshold) {
      // Trend faded: take profit gradually instead of flipping all at once.
      if (Math.abs(this.inventory) < 10) return [];
      const size = Math.min(int(Math.abs(this.inventory) / 4) + 1, 40);
      return this.inventory > 0
        ? [{ side: "sell", quantity: size, price: state.bestBid }]
        : [{ side: "buy", quantity: size, price: state.bestAsk }];
    }

    const room = m > 0 ? this.maxPosition - this.inventory : this.maxPosition + this.inventory;
    const size = Math.min(int(Math.min(Math.abs(m) * 5000, 40)), room);
    if (size <= 0) return [];
    return m > 0
      ? [{ side: "buy", quantity: size, price: state.bestAsk }]
      : [{ side: "sell", quantity: size, price: state.bestBid }];
  }
}

export class NoiseTrader extends Agent {
  kind = "noise" as const;

  rate: number;

  constructor(name: string, rate = 0.35) {
    super(name);
    this.rate = rate;
  }

  act(state: MarketState): Intent[] {
    if (Math.random() > this.rate) return [];
    const side: Side = Math.random() < 0.5 ? "buy" : "sell";
    const size = randint(5, 120);
    if (Math.random() < 0.3) return [{ side, quantity: size, price: null }];
    const m = mid(state);
    const offset = randint(1, Math.max(2, int(m * 0.0015)));
    return [{ side, quantity: size, price: Math.max(1, side === "sell" ? m + offset : m - offset) }];
  }
}

export class MarketMaker extends Agent {
  kind = "maker" as const;
  resting: number[] = [];

  halfSpread: number;
  levels: number;

  constructor(name: string, halfSpread = 0.00025, levels = 3) {
    super(name);
    this.halfSpread = halfSpread;
    this.levels = levels;
  }

  act(state: MarketState): Intent[] {
    const m = mid(state);
    const half = Math.max(1, int(m * this.halfSpread));
    const step = Math.max(1, int(m * 0.0005));
    const skew = int(-this.inventory * 0.02);
    const out: Intent[] = [];
    for (let i = 0; i < this.levels; i++) {
      const size = randint(40, 180);
      out.push({ side: "buy", quantity: size, price: m - half - i * step + skew });
      out.push({ side: "sell", quantity: size, price: m + half + i * step + skew });
    }
    return out;
  }
}

export function buildPopulation(pop: Population): Agent[] {
  const values = Array.from({ length: pop.value }, (_, i) => new ValueTrader(`value_${i}`));
  // Center the value traders' errors so the crowd as a whole is not biased.
  if (values.length) {
    const mean = values.reduce((s, v) => s + v.bias, 0) / values.length;
    for (const v of values) v.bias -= mean;
  }
  return [
    ...values,
    ...Array.from({ length: pop.momentum }, (_, i) => new MomentumTrader(`momentum_${i}`)),
    ...Array.from({ length: pop.noise }, (_, i) => new NoiseTrader(`noise_${i}`)),
    ...Array.from({ length: pop.maker }, (_, i) => new MarketMaker(`maker_${i}`)),
  ];
}
