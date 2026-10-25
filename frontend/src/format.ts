const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Integer cents to "$1,234.56". */
export const money = (cents: number) => usd.format(cents / 100);

/** "+$31.20" / "−$12.00", with a real minus sign. */
export const signed = (cents: number) =>
  (cents >= 0 ? "+" : "−") + usd.format(Math.abs(cents) / 100);

export const pct = (x: number, digits = 2) =>
  (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(digits) + "%";

export const tone = (x: number) => (x > 0 ? "up" : x < 0 ? "down" : "");

/** Turn a trade-side label into plain English: "momentum" -> "A momentum trader". */
export function who(label: string | null, me: string | null): string {
  if (!label) return "Someone";
  if (me && label === me) return "You";
  const agents: Record<string, string> = {
    maker: "A market maker",
    momentum: "A momentum trader",
    value: "A value trader",
    noise: "Another trader",
    "big order": "A large order",
  };
  return agents[label] ?? label;
}
