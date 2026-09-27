import { useEffect, useMemo, useRef, useState } from "react";
import type { OverviewPayload, RelationInfo, TableSummary } from "#shared/types.ts";
import { compact, heatColor } from "../lib/format.ts";
import { usePreferences } from "../lib/preferences.tsx";

interface Node {
  table: TableSummary;
  x: number;
  y: number;
  w: number;
  h: number;
}

const WIDTH = 1000;
const HEIGHT = 560;

/**
 * Force-directed layout, run to completion before first paint.
 *
 * A deterministic seeded start plus a fixed iteration count means the same
 * schema always draws the same way — people build a spatial memory of their
 * live database during investigation, and a diagram that reshuffles on every refresh
 * destroys that.
 */
function layout(tables: TableSummary[], relations: RelationInfo[]): Node[] {
  const maxRows = Math.max(1, ...tables.map((t) => t.rows));

  const nodes: Node[] = tables.map((table, i) => {
    // Area encodes row count (sqrt keeps a 100× difference readable rather
    // than letting one table swallow the canvas).
    const scale = Math.sqrt(table.rows / maxRows);
    // The box must also fit its own text, or long names on small tables spill
    // outside the rectangle. 6.7px/char matches the 11px monospace label.
    const labelWidth = table.name.length * 6.7 + 20;
    const w = Math.round(Math.max(78 + scale * 112, labelWidth));
    const h = Math.round(46 + scale * 40);
    // Golden-angle spiral: even initial spread, no randomness.
    const angle = i * 2.399963;
    const radius = 60 + i * 26;
    return {
      table,
      x: WIDTH / 2 + Math.cos(angle) * radius,
      y: HEIGHT / 2 + Math.sin(angle) * radius,
      w,
      h,
    };
  });

  const index = new Map(nodes.map((node) => [node.table.name, node]));
  const links = relations
    .map((rel) => ({ a: index.get(rel.fromTable), b: index.get(rel.toTable) }))
    .filter((l): l is { a: Node; b: Node } => Boolean(l.a && l.b && l.a !== l.b));

  for (let step = 0; step < 460; step++) {
    const cooling = 1 - step / 460;

    // Repulsion, scaled by size so big tables claim the room they need.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const minGap = (a.w + b.w) / 2 + 46;
        if (dist < minGap) {
          const push = ((minGap - dist) / dist) * 0.5 * cooling;
          dx *= push;
          dy *= push;
          a.x -= dx;
          a.y -= dy;
          b.x += dx;
          b.y += dy;
        }
      }
    }

    // Attraction along relations.
    for (const { a, b } of links) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const target = (a.w + b.w) / 2 + 92;
      const pull = ((dist - target) / dist) * 0.045 * cooling;
      a.x += dx * pull;
      a.y += dy * pull;
      b.x -= dx * pull;
      b.y -= dy * pull;
    }

    // Gentle centering so disconnected tables do not drift off-canvas.
    for (const node of nodes) {
      node.x += (WIDTH / 2 - node.x) * 0.004 * cooling;
      node.y += (HEIGHT / 2 - node.y) * 0.004 * cooling;
    }
  }

  // Clamp inside the viewport with a margin for labels.
  for (const node of nodes) {
    node.x = Math.max(node.w / 2 + 14, Math.min(WIDTH - node.w / 2 - 14, node.x));
    node.y = Math.max(node.h / 2 + 22, Math.min(HEIGHT - node.h / 2 - 22, node.y));
  }

  return nodes;
}

/** Edge anchored to the rectangles' borders rather than their centers. */
function edgePath(a: Node, b: Node): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const angle = Math.atan2(dy, dx);
  const from = borderPoint(a, angle);
  const to = borderPoint(b, angle + Math.PI);
  // A slight arc keeps reciprocal relations from overlapping into one line.
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const offset = Math.hypot(dx, dy) * 0.08;
  const nx = -Math.sin(angle) * offset;
  const ny = Math.cos(angle) * offset;
  return `M ${from.x} ${from.y} Q ${mx + nx} ${my + ny} ${to.x} ${to.y}`;
}

function borderPoint(node: Node, angle: number): { x: number; y: number } {
  const hw = node.w / 2 + 3;
  const hh = node.h / 2 + 3;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const scale = Math.min(hw / Math.max(Math.abs(cos), 1e-6), hh / Math.max(Math.abs(sin), 1e-6));
  return { x: node.x + cos * scale, y: node.y + sin * scale };
}

export function HeatGraph({
  overview,
  onSelect,
}: {
  overview: OverviewPayload;
  onSelect: (table: string) => void;
}) {
  const { t } = usePreferences();
  const nodes = useMemo(
    () => layout(overview.tables, overview.relations),
    [overview.tables, overview.relations],
  );
  const byName = useMemo(() => new Map(nodes.map((n) => [n.table.name, n])), [nodes]);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(
    null,
  );
  const svgRef = useRef<SVGSVGElement>(null);

  /**
   * Pan without capturing the pointer.
   *
   * setPointerCapture on the <svg> would retarget every subsequent event to it,
   * which silently swallows clicks on the nodes — making tables unopenable. The
   * `moved` flag instead distinguishes a pan from a click, so both work.
   */
  const startPan = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y, moved: false };
  };

  const movePan = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // A few pixels of travel during a click must not count as a drag.
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
  };

  // pointerup fires before click, so whether the gesture was a pan has to
  // outlive `drag` for the click handler to see it.
  const panned = useRef(false);

  const endPan = () => {
    panned.current = drag.current?.moved ?? false;
    drag.current = null;
  };

  /** Ignore the click that ends a pan gesture. */
  const clickNode = (table: string) => {
    if (panned.current) {
      panned.current = false;
      return;
    }
    onSelect(table);
  };

  // Wheel zoom must be a non-passive listener to be preventable, which React's
  // onWheel prop cannot guarantee.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      // Ordinary wheel/trackpad motion scrolls the page. Ctrl/⌘ explicitly
      // opts into graph zoom, avoiding a large scroll trap.
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setView((v) => ({
        ...v,
        k: Math.max(0.45, Math.min(2.6, v.k * (e.deltaY < 0 ? 1.12 : 0.89))),
      }));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const highlighted = new Set<string>();
  if (hover) {
    for (const rel of overview.relations) {
      if (rel.fromTable === hover) highlighted.add(rel.toTable);
      if (rel.toTable === hover) highlighted.add(rel.fromTable);
    }
  }

  return (
    <div className="graph-wrap">
      <svg
        ref={svgRef}
        className="graph-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ height: HEIGHT }}
        role="img"
        aria-label="Database relation map, sized by row count and colored by load"
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerLeave={endPan}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <g>
            {overview.relations.map((rel, i) => {
              const a = byName.get(rel.fromTable);
              const b = byName.get(rel.toTable);
              if (!a || !b || a === b) return null;
              const active = !hover || rel.fromTable === hover || rel.toTable === hover;
              return (
                <path
                  key={`${rel.fromTable}.${rel.fromColumn}-${rel.toTable}-${i}`}
                  className={[
                    "edge",
                    rel.unindexed ? "edge-unindexed" : "",
                    rel.kind === "inferred" && !rel.unindexed ? "edge-inferred" : "",
                  ].join(" ")}
                  d={edgePath(a, b)}
                  opacity={active ? undefined : 0.12}
                >
                  <title>
                    {`${rel.fromTable}.${rel.fromColumn} → ${rel.toTable}.${rel.toColumn}`}
                    {rel.kind === "inferred" ? " (inferred from naming)" : " (foreign key)"}
                    {rel.unindexed ? " — NO INDEX on the join column" : ""}
                  </title>
                </path>
              );
            })}
          </g>

          <g>
            {nodes.map((node) => {
              const { table } = node;
              const color = heatColor(table.heat);
              const dim = hover && hover !== table.name && !highlighted.has(table.name);
              const criticals = table.issues.filter((i) => i.severity === "critical").length;

              return (
                <g
                  key={table.name}
                  className="node-g"
                  opacity={dim ? 0.28 : 1}
                  onMouseEnter={() => setHover(table.name)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => clickNode(table.name)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${table.name}, ${table.rows} rows, heat ${table.heat} of 100`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(table.name);
                    }
                  }}
                >
                  <rect
                    className="node-body"
                    x={node.x - node.w / 2}
                    y={node.y - node.h / 2}
                    width={node.w}
                    height={node.h}
                    rx={3}
                    fill={color}
                    fillOpacity={0.14 + (table.heat / 100) * 0.3}
                    stroke={color}
                    strokeWidth={hover === table.name ? 2 : 1.2}
                  />
                  {/* Heat bar along the top edge: a second, redundant encoding
                      so the ranking survives any color-vision difference. */}
                  <rect
                    x={node.x - node.w / 2}
                    y={node.y - node.h / 2}
                    width={(node.w * table.heat) / 100}
                    height={2.5}
                    fill={color}
                  />
                  <text className="node-label" x={node.x} y={node.y - 2}>
                    {table.name}
                  </text>
                  <text className="node-meta" x={node.x} y={node.y + 13}>
                    {compact(table.rows)} · {table.indexCount} idx
                  </text>
                  {criticals > 0 ? (
                    <circle
                      cx={node.x + node.w / 2 - 7}
                      cy={node.y - node.h / 2 + 7}
                      r={3.4}
                      fill="var(--t4)"
                    />
                  ) : null}
                  <title>
                    {`${table.name}\n${table.rows.toLocaleString()} rows (estimate)\n` +
                      `${table.indexCount} secondary index(es)\nheat ${table.heat}/100` +
                      (table.load
                        ? `\n${Math.round(table.load.totalTimeMs)} ms total query time`
                        : "")}
                  </title>
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      <div className="graph-hint">{t("graphHint")}</div>

      <div className="graph-legend">
        <div>{t("graphLegend")}</div>
        <div className="legend-ramp" />
        <div className="legend-scale">
          <span>{t("cold")}</span>
          <span>{t("hot")}</span>
        </div>
        <div className="legend-key">
          <span className="legend-line" />
          <span>{t("unindexedJoin")}</span>
        </div>
      </div>
    </div>
  );
}
