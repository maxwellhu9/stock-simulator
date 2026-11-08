import { useEffect, useRef, useState } from "react";

export interface Point {
  t: number; // seconds
  v: number; // cents
}

/** A moment worth flagging on the chart, e.g. when a headline hit. */
export interface Marker {
  t: number;
  tone: "up" | "down" | "accent";
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
  markers?: Marker[];
  /** Text for the label above the crosshair. */
  formatTime?: (t: number) => string;
}

const clockTime = (t: number) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

/**
 * A single-line price chart with hover scrubbing.
 *
 * Written by hand rather than pulled from a charting library: it draws exactly
 * one thing, and doing it directly keeps the bundle small and the look clean
 * (no axes, gridlines, or legends the screen doesn't need).
 *
 * The crosshair follows the cursor exactly and reads the price off the line
 * between points, so scrubbing glides instead of jumping from point to point.
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

/** The line's value at time t, interpolated between the two nearest points. */
function valueAt(pts: Point[], t: number): Point {
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  return { t, v: Math.round(a.v + (b.v - a.v) * k) };
}

export function PriceChart({
  series: rawSeries,
  reference: rawReference,
  height = 260,
  colorBy = "direction",
  baseline,
  onScrub,
  markers,
  formatTime = clockTime,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null); // a time, in seconds

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
    const t = Math.min(t1, Math.max(t0, t0 + ((rx - pad) / (width - pad * 2)) * tspan));
    setHover(t);
    onScrub?.(valueAt(series, t));
  }

  const hp = hover !== null ? valueAt(series, Math.min(t1, Math.max(t0, hover))) : null;
  const end = series[series.length - 1];

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
        {(markers ?? [])
          .filter((m) => m.t >= t0 && m.t <= t1)
          .map((m, i) => {
            const color = m.tone === "up" ? "var(--up)" : m.tone === "down" ? "var(--down)" : "var(--accent)";
            return (
              <g key={i}>
                <line x1={x(m.t)} x2={x(m.t)} y1={6} y2={height} stroke={color}
                      strokeWidth={1.25} strokeDasharray="3 4" opacity={0.7} />
                <circle cx={x(m.t)} cy={6} r={4.5} fill={color} />
              </g>
            );
          })}
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
        <path d={path(series)} fill="none" stroke={stroke} strokeWidth={1.75}
              strokeLinejoin="round" strokeLinecap="round" />
        {hp ? (
          <>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={0} y2={height}
                  stroke="var(--ink-3)" strokeWidth={1} />
            <circle cx={x(hp.t)} cy={y(hp.v)} r={5} fill={stroke}
                    stroke="var(--card)" strokeWidth={2} />
          </>
        ) : (
          <circle cx={x(end.t)} cy={y(end.v)} r={3.5} fill={stroke} />
        )}
      </svg>
      {hp && (
        <div className="chart-time num" style={{ left: Math.min(width - 60, Math.max(60, x(hp.t))) }}>
          {formatTime(hp.t)}
        </div>
      )}
    </div>
  );
}
