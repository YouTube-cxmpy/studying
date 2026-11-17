"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compile } from "@/lib/mathexpr";

// Pictures inside generated lessons, reviews and quizzes. The model writes them
// as fenced blocks: ```graph with a small JSON spec (drawn here, so the curve is
// exactly the function), or ```svg for other diagrams (sanitized before display).

interface GraphSpec {
  x?: [number, number];
  y?: [number, number];
  functions?: { fn: string; label?: string; dashed?: boolean }[];
  points?: { x: number; y: number; label?: string }[];
  vlines?: { x: number; label?: string }[];
  hlines?: { y: number; label?: string }[];
}

const W = 560;
const H = 380;
const PAD = { l: 40, r: 16, t: 14, b: 30 };
const COLORS = ["var(--lesson)", "var(--quiz)", "var(--review)", "var(--cards)"];

function niceStep(span: number): number {
  const raw = span / 10;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

const SUPERSCRIPT: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻" };

/** "(x-1)^2 - 2" → "(x − 1)² − 2", for labels the model didn't write itself. */
function pretty(fn: string): string {
  return fn
    .replace(/\^\(?(-?\d+)\)?/g, (_, n: string) => [...n].map((c) => SUPERSCRIPT[c] ?? c).join(""))
    .replace(/\*/g, "·")
    .replace(/\s*([+=])\s*/g, " $1 ")
    .replace(/(\S)\s*-\s*/g, "$1 − ")
    .replace(/-/g, "−");
}

const fmt = (v: number) => (Math.abs(v) < 1e-9 ? "0" : Number(v.toFixed(6)).toString().replace("-", "−"));

function range(r: unknown): [number, number] | null {
  if (!Array.isArray(r) || r.length !== 2) return null;
  const [a, b] = r.map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b > a && b - a < 1e7 ? [a, b] : null;
}

function Graph({ spec }: { spec: GraphSpec }) {
  const drawn = useMemo(() => {
    const [x0, x1] = range(spec.x) ?? [-10, 10];
    const fns = (spec.functions ?? []).slice(0, 4).map((f, i) => {
      try {
        return { ...f, f: compile(String(f.fn)), color: COLORS[i % COLORS.length] };
      } catch {
        return null;
      }
    });
    if (fns.some((f) => f === null)) return null;
    const ok = fns as NonNullable<(typeof fns)[number]>[];

    // y range: given, or fitted to the curves and points.
    let yr = range(spec.y);
    if (!yr) {
      const ys: number[] = [];
      for (const f of ok) for (let i = 0; i <= 100; i++) ys.push(f.f(x0 + ((x1 - x0) * i) / 100));
      for (const p of spec.points ?? []) ys.push(Number(p.y));
      const finite = ys.filter(Number.isFinite).sort((a, b) => a - b);
      const lo = finite[Math.floor(finite.length * 0.02)] ?? -10;
      const hi = finite[Math.ceil(finite.length * 0.98) - 1] ?? 10;
      const pad = Math.max((hi - lo) * 0.1, 1);
      yr = [Math.min(lo - pad, 0), Math.max(hi + pad, 0)];
    }
    const [y0, y1] = yr;
    const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
    const sy = (y: number) => H - PAD.b - ((y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);

    const paths = ok.map((f) => {
      const parts: string[] = [];
      let open = false;
      let prev = NaN;
      const span = y1 - y0;
      for (let i = 0; i <= 800; i++) {
        const x = x0 + ((x1 - x0) * i) / 800;
        const y = f.f(x);
        // Break the line at gaps and vertical asymptotes.
        const usable = Number.isFinite(y) && y > y0 - 4 * span && y < y1 + 4 * span;
        const jump = open && Math.abs(y - prev) > 2 * span;
        if (!usable || jump) {
          open = false;
          prev = y;
          if (!usable) continue;
        }
        parts.push(`${open ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`);
        open = true;
        prev = y;
      }
      return { d: parts.join(""), color: f.color, label: f.label ?? `y = ${pretty(String(f.fn))}`, dashed: Boolean(f.dashed) };
    });

    const xs = niceStep(x1 - x0);
    const ysStep = niceStep(y1 - y0);
    const ticks = (a: number, b: number, s: number) => {
      const out: number[] = [];
      for (let v = Math.ceil(a / s) * s; v <= b + 1e-9; v += s) out.push(Number(v.toFixed(10)));
      return out;
    };
    return { x0, x1, y0, y1, sx, sy, paths, xt: ticks(x0, x1, xs), yt: ticks(y0, y1, ysStep) };
  }, [spec]);

  if (!drawn) return <p className="figure-error">This graph couldn&apos;t be drawn.</p>;
  const { x0, x1, y0, y1, sx, sy, paths, xt, yt } = drawn;
  const axisX = sy(Math.min(Math.max(0, y0), y1));
  const axisY = sx(Math.min(Math.max(0, x0), x1));
  const describe = [
    ...paths.map((p) => p.label),
    ...(spec.points ?? []).map((p) => p.label ?? `point (${fmt(p.x)}, ${fmt(p.y)})`),
  ].join("; ");

  return (
    <figure className="figure figure-graph">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Graph: ${describe}`}>
        <defs>
          <clipPath id="plot-area">
            <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} />
          </clipPath>
        </defs>
        {xt.map((v) => (
          <line key={`gx${v}`} x1={sx(v)} x2={sx(v)} y1={PAD.t} y2={H - PAD.b} className="g-grid" />
        ))}
        {yt.map((v) => (
          <line key={`gy${v}`} x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} className="g-grid" />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={axisX} y2={axisX} className="g-axis" />
        <line x1={axisY} x2={axisY} y1={PAD.t} y2={H - PAD.b} className="g-axis" />
        {xt.map((v) =>
          Math.abs(v) < 1e-9 ? null : (
            <text key={`tx${v}`} x={sx(v)} y={Math.min(axisX + 15, H - 8)} className="g-tick" textAnchor="middle">
              {fmt(v)}
            </text>
          ),
        )}
        {yt.map((v) =>
          Math.abs(v) < 1e-9 ? null : (
            <text key={`ty${v}`} x={Math.max(axisY - 6, 30)} y={sy(v) + 4} className="g-tick" textAnchor="end">
              {fmt(v)}
            </text>
          ),
        )}
        <g clipPath="url(#plot-area)">
          {(spec.vlines ?? []).map((l, i) => (
            <line key={`v${i}`} x1={sx(Number(l.x))} x2={sx(Number(l.x))} y1={PAD.t} y2={H - PAD.b} className="g-guide" />
          ))}
          {(spec.hlines ?? []).map((l, i) => (
            <line key={`h${i}`} x1={PAD.l} x2={W - PAD.r} y1={sy(Number(l.y))} y2={sy(Number(l.y))} className="g-guide" />
          ))}
          {paths.map((p, i) => (
            <path key={i} d={p.d} className="g-curve" style={{ stroke: p.color }} strokeDasharray={p.dashed ? "7 6" : undefined} />
          ))}
        </g>
        {(spec.vlines ?? []).map((l, i) =>
          l.label ? (
            <text key={`vl${i}`} x={sx(Number(l.x)) + 5} y={PAD.t + 14} className="g-label">
              {l.label}
            </text>
          ) : null,
        )}
        {(spec.hlines ?? []).map((l, i) =>
          l.label ? (
            <text key={`hl${i}`} x={W - PAD.r - 4} y={sy(Number(l.y)) - 6} className="g-label" textAnchor="end">
              {l.label}
            </text>
          ) : null,
        )}
        {(spec.points ?? []).map((p, i) => {
          const px = sx(Number(p.x));
          const py = sy(Number(p.y));
          if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
          const right = px < W - 170;
          return (
            <g key={`p${i}`}>
              <circle cx={px} cy={py} r={5} className="g-point" />
              {p.label && (
                <text x={px + (right ? 9 : -9)} y={py - 9} className="g-label" textAnchor={right ? "start" : "end"}>
                  {p.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {paths.length > 0 && (
        <div className="g-legend">
          {paths.map((p, i) => (
            <span key={i}>
              <i style={{ background: p.color }} />
              {p.label}
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}

function Diagram({ source }: { source: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void import("dompurify").then(({ default: DOMPurify }) => {
      if (cancelled || !host.current) return;
      const clean = DOMPurify.sanitize(source, {
        USE_PROFILES: { svg: true, svgFilters: false },
        FORBID_TAGS: ["foreignObject", "image", "a", "style", "script", "use"],
        FORBID_ATTR: ["href", "xlink:href", "style"],
      });
      const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
      const svg = doc.documentElement;
      if (svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
        setFailed(true);
        return;
      }
      if (!svg.getAttribute("viewBox")) {
        const w = parseFloat(svg.getAttribute("width") ?? "");
        const h = parseFloat(svg.getAttribute("height") ?? "");
        if (w > 0 && h > 0) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      }
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.setAttribute("role", "img");
      host.current.replaceChildren(document.importNode(svg, true));
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (failed) return <p className="figure-error">This picture couldn&apos;t be drawn.</p>;
  return <div className="figure figure-diagram" ref={host} />;
}

/** Renders a fenced ```graph or ```svg block. Returns null for any other language. */
export function FigureBlock({ lang, source }: { lang: string; source: string }) {
  const graph = useMemo(() => {
    if (lang !== "graph") return null;
    try {
      return JSON.parse(source) as GraphSpec;
    } catch {
      return "invalid" as const;
    }
  }, [lang, source]);

  if (lang === "svg") return <Diagram source={source} />;
  if (lang !== "graph") return null;
  if (graph === "invalid" || graph === null) return <p className="figure-error">This graph couldn&apos;t be drawn.</p>;
  return <Graph spec={graph} />;
}
