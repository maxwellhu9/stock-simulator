// A TypeScript port of backend/app/history.py: made-up prices from before the
// market started, so long chart ranges have something to show.

import type { Bar } from "./exchange";

// [seconds per step, number of steps, typical size of one step]
const LAYERS: [number, number, number][] = [
  [15, 240, 0.004],
  [300, 276, 0.004],
  [3600, 2136, 0.0055],
  [86400, 1735, 0.015],
];
const DAILY_DRIFT = 0.00046;

/** Small seeded generator, so a stock keeps the same past on every reload. */
function seeded(text: string): () => number {
  let a = 2166136261;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One bar per step, oldest first, ending just before `start`. */
export function makeHistory(symbol: string, start: number, price: number): Bar[] {
  const random = seeded(symbol);
  const gauss = (sigma: number) =>
    sigma * Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

  const out: Bar[] = [];
  let t = start;
  let logPrice = Math.log(price);
  let calm = 0; // volatility comes in stretches, not evenly
  for (const [seconds, steps, size] of LAYERS) {
    for (let i = 0; i < steps; i++) {
      calm = 0.97 * calm + gauss(0.12);
      let step = gauss(size * Math.exp(calm));
      if (random() < 0.015) step += gauss(size * 4); // the odd earnings-sized jump
      logPrice -= step + (DAILY_DRIFT * seconds) / 86400;
      t -= seconds;
      const close = Math.max(100, Math.round(Math.exp(logPrice)));
      out.push({ t: Math.floor(t), open: close, high: close, low: close, close, volume: 0 });
    }
  }
  return out.reverse();
}
