import type { MarketEvent } from "../types";

function ago(t: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/** The latest thing that happened to this market, in one line. */
export function Headline({ event }: { event: MarketEvent | undefined }) {
  if (!event) return null;
  const tone = event.kind === "good" ? "up" : event.kind === "bad" ? "down" : "";
  return (
    <div className="headline">
      <span className="headline-tag">{event.kind === "scenario" ? "Scenario" : "Simulated news"}</span>
      <span className="headline-text">
        {event.symbol && event.kind !== "scenario" ? <b>{event.symbol} </b> : null}
        {event.headline}
      </span>
      {event.impact_pct !== 0 && (
        <span className={`headline-move num ${tone}`}>
          {event.impact_pct > 0 ? "+" : "−"}{Math.abs(event.impact_pct).toFixed(1)}% worth
        </span>
      )}
      <span className="muted headline-ago">{ago(event.t)}</span>
    </div>
  );
}
