import { useEffect, useRef, useState } from "react";

export interface Point {
  t: number; // seconds
  v: number; // cents
}

interface Props {
  series: Point[];
  /** Optional second line, drawn dashed and quiet -- used for fair value. */
  reference?: Point[];
  height?: number;
  /** Colour the main line by direction (green up / red down) or keep it black. */
  colorBy?: "direction" | "ink";
  /** Draw a dashed horizontal line here, e.g. where the period started. */
  baseline?: number;
  onScrub?: (p: Point | null) => void;
}

/**
 * A single-line price chart with hover scrubbing.
 *
 * Written by hand rather than pulled from a charting library: it draws exactly
 * one thing, and doing it directly keeps the bundle small and the look clean
 * (no axes, gridlines, or legends the screen doesn't need).
 *
 * Measures its own width so strokes stay crisp instead of being stretched by a
 * scaled viewBox.
 */
/** Keep about one point per two pixels. More than that just aliases into noise. */
function thin(pts: Point[], max: number): Point[] {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out: Point[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  out[out.length - 1] = pts[pts.length - 1]; // always end on the latest value
  return out;
}

export function PriceChart({
  series: rawSeries,
  reference: rawReference,
  height = 260,
  colorBy = "direction",
  baseline,
  onScrub,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const budget = Math.max(40, Math.floor(width / 2));
  const series = thin(rawSeries, budget);
  const reference = rawReference ? thin(rawReference, budget) : undefined;

  if (series.length < 2) {
    return (
      <div ref={box} style={{ height, display: "grid", placeItems: "center" }}>
        <span className="muted" style={{ fontSize: 14 }}>
          Waiting for trades…
        </span>
      </div>
    );
  }

  const pad = 8;
  const all = [...series, ...(reference ?? [])];
  let lo = Math.min(...all.map((p) => p.v));
  let hi = Math.max(...all.map((p) => p.v));
  if (baseline !== undefined) {
    lo = Math.min(lo, baseline);
    hi = Math.max(hi, baseline);
  }
  const span = Math.max(hi - lo, 1);
  lo -= span * 0.08;
  hi += span * 0.08;

  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const tspan = Math.max(t1 - t0, 1);
  const x = (t: number) => pad + ((t - t0) / tspan) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2);
  const path = (pts: Point[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");

  const first = series[0].v;
  const last = series[series.length - 1].v;
  const stroke =
    colorBy === "ink" ? "var(--ink)" : last >= first ? "var(--up)" : "var(--down)";

  function scrub(clientX: number) {
    if (!box.current) return;
    const rx = clientX - box.current.getBoundingClientRect().left;
    const t = t0 + ((rx - pad) / (width - pad * 2)) * tspan;
    let best = 0;
    for (let i = 1; i < series.length; i++) {
      if (Math.abs(series[i].t - t) < Math.abs(series[best].t - t)) best = i;
    }
    setHover(best);
    onScrub?.(series[best]);
  }

  const hp = hover !== null ? series[hover] : null;

  return (
    <div
      ref={box}
      style={{ height, position: "relative", touchAction: "none" }}
      onPointerMove={(e) => scrub(e.clientX)}
      onPointerLeave={() => {
        setHover(null);
        onScrub?.(null);
      }}
    >
      <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
        {baseline !== undefined && (
          <line
            x1={pad} x2={width - pad} y1={y(baseline)} y2={y(baseline)}
            stroke="var(--line)" strokeWidth={1.5} strokeDasharray="2 5"
          />
        )}
        {reference && reference.length > 1 && (
          <path d={path(reference)} fill="none" stroke="var(--ink-3)"
                strokeWidth={1.5} strokeDasharray="5 5" />
        )}
        <path d={path(series)} fill="none" stroke={stroke} strokeWidth={2.25}
              strokeLinejoin="round" strokeLinecap="round" />
        {hp && (
          <>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={0} y2={height}
                  stroke="var(--ink-3)" strokeWidth={1} />
            <circle cx={x(hp.t)} cy={y(hp.v)} r={5} fill={stroke}
                    stroke="var(--bg)" strokeWidth={2.5} />
          </>
        )}
      </svg>
    </div>
  );
}
