/** Formatting helpers. Every number in this tool is read under time pressure. */

const nf = new Intl.NumberFormat("en-US");

export function n(value: number): string {
  return nf.format(Math.round(value));
}

/** Compact counts for dense spots: 262,144 -> 262k. */
export function compact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export function bytes(value: number): string {
  if (value >= 1 << 30) return `${(value / (1 << 30)).toFixed(1)} GB`;
  if (value >= 1 << 20) return `${(value / (1 << 20)).toFixed(1)} MB`;
  if (value >= 1 << 10) return `${(value / (1 << 10)).toFixed(0)} KB`;
  return `${value} B`;
}

/** Sub-millisecond timings matter when comparing plans; keep one decimal. */
export function ms(value: number): string {
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 10) return `${value.toFixed(0)} ms`;
  if (value >= 1) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)} ms`;
}

/**
 * Map a 0..100 heat value onto the thermal ramp.
 *
 * The stops match the CSS custom properties exactly; keeping the ramp in JS too
 * lets SVG fills interpolate smoothly instead of snapping between classes.
 */
const RAMP: Array<[number, [number, number, number]]> = [
  [0, [43, 179, 192]],
  [30, [79, 199, 161]],
  [55, [232, 180, 74]],
  [78, [242, 120, 60]],
  [100, [232, 67, 79]],
];

export function heatColor(heat: number): string {
  const h = Math.max(0, Math.min(100, heat));
  for (let i = 0; i < RAMP.length - 1; i++) {
    const [stop, color] = RAMP[i]!;
    const [nextStop, nextColor] = RAMP[i + 1]!;
    if (h > nextStop) continue;
    const t = nextStop === stop ? 0 : (h - stop) / (nextStop - stop);
    const mix = color.map((c, j) => Math.round(c + (nextColor[j]! - c) * t));
    return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
  }
  return "rgb(232, 67, 79)";
}

export function severityClass(severity: string): string {
  return severity === "critical" ? "crit" : severity === "warning" ? "warn" : "";
}

/** Render a cell value without letting a TEXT blob wreck the table layout. */
export function cell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) return { text: "NULL", isNull: true };
  if (value instanceof Date) return { text: value.toISOString(), isNull: false };
  if (typeof value === "object") {
    // Buffers arrive as {type:'Buffer',data:[...]}; show the size, not the bytes.
    const maybe = value as { type?: string; data?: unknown[] };
    if (maybe.type === "Buffer" && Array.isArray(maybe.data)) {
      return { text: `<binary ${maybe.data.length} B>`, isNull: false };
    }
    return { text: JSON.stringify(value), isNull: false };
  }
  const text = String(value);
  return { text: text.length > 160 ? `${text.slice(0, 160)}…` : text, isNull: false };
}

/** Light SQL prettifier: puts major clauses on their own line. */
export function prettySql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(
      /\b(FROM|WHERE|ORDER BY|GROUP BY|LIMIT|LEFT JOIN|RIGHT JOIN|INNER JOIN|JOIN|HAVING|UNION ALL|UNION)\b/gi,
      "\n$1",
    )
    .trim();
}
