/** Share of the whole, as a ring. */
export function Donut({ parts, size = 150, label, sub }: {
  parts: { value: number; color: string }[]; size?: number; label?: string; sub?: string;
}) {
  const total = parts.reduce((n, p) => n + p.value, 0) || 1;
  const r = 52, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox="0 0 140 140" aria-hidden>
      <circle cx="70" cy="70" r={r} fill="none" stroke="var(--panel)" strokeWidth={18} />
      {parts.filter((p) => p.value > 0).map((p, i) => {
        const len = (p.value / total) * c;
        const seg = (
          <circle key={i} cx="70" cy="70" r={r} fill="none" stroke={p.color} strokeWidth={18}
                  strokeDasharray={`${Math.max(len - 2, 0.5)} ${c}`} strokeDashoffset={-offset}
                  transform="rotate(-90 70 70)" strokeLinecap="butt" />
        );
        offset += len;
        return seg;
      })}
      {label && <text x="70" y="68" textAnchor="middle" fontSize="15" fontWeight="800" fill="var(--ink)">{label}</text>}
      {sub && <text x="70" y="86" textAnchor="middle" fontSize="10" fill="var(--ink-3)">{sub}</text>}
    </svg>
  );
}
