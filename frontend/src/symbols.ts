/** Display details for each stock. Colours are our own, not the companies'. */
export const STOCKS: Record<string, { name: string; color: string }> = {
  AAPL: { name: "Apple", color: "var(--s-aapl)" },
  NVDA: { name: "NVIDIA", color: "var(--s-nvda)" },
  MSFT: { name: "Microsoft", color: "var(--s-msft)" },
};

export const stockColor = (s: string) => STOCKS[s]?.color ?? "var(--ink-3)";
export const stockName = (s: string) => STOCKS[s]?.name ?? s;

/** A soft tinted background in the stock's colour. */
export const tint = (s: string, pct = 14) =>
  `color-mix(in srgb, ${stockColor(s)} ${pct}%, white)`;
