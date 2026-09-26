"use client";

import { useState } from "react";

/**
 * Magnitudes across categories as horizontal bars: one hue (the chart token), values as text in
 * ink colours next to each bar, so nothing depends on colour alone. Hovering is not needed: every
 * value is printed.
 */
export function BarList({
  items,
  caption,
  max,
}: {
  items: { key: string; label: string; value: number; detail?: string }[];
  caption: string;
  /** Scale to this instead of the largest value (e.g. calls, for a funnel) */
  max?: number;
}) {
  const top = Math.max(1, max ?? 0, ...items.map((i) => i.value));
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {items.map((i) => (
          <tr key={i.key} className="align-middle">
            <th
              scope="row"
              className="w-2/5 py-1.5 pr-3 text-left font-normal text-slate-600 dark:text-slate-300"
            >
              {i.label}
            </th>
            <td className="py-1.5">
              <div className="flex items-center gap-2">
                <div className="h-3 flex-1" aria-hidden>
                  {i.value > 0 ? (
                    <div
                      className="h-3 rounded-r-[4px]"
                      style={{
                        width: `${Math.max(2, (i.value / top) * 100)}%`,
                        background: "var(--chart-bar)",
                      }}
                    />
                  ) : null}
                </div>
                <span className="w-24 shrink-0 text-right tabular-nums">
                  {i.value.toLocaleString()}
                  {i.detail ? <span className="ml-1 text-xs text-slate-500">{i.detail}</span> : null}
                </span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const W = 720;
const H = 180;
const PAD = { top: 10, right: 8, bottom: 26, left: 36 };

function niceMax(n: number): number {
  if (n <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / step) * step;
}

/**
 * Counts per category (e.g. calls per hour of the day): one series, rounded data ends on the
 * baseline, a 2px gap between bars, hover/focus tooltip, and a table for screen readers.
 */
export function ColumnChart({
  data,
  caption,
  unit,
}: {
  data: { label: string; short: string; value: number }[];
  caption: string;
  unit: (n: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(24, slot - 2));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const labelEvery = Math.ceil(data.length / 8);
  const a = active !== null ? data[active] : undefined;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              fontSize={11}
              fill="var(--chart-axis)"
            >
              {t.toLocaleString()}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const h = Math.max(0, y(0) - y(d.value));
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={d.label}>
              {h > 0 ? (
                <path
                  d={`M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
                  fill="var(--chart-bar)"
                  opacity={active === null || active === i ? 1 : 0.45}
                />
              ) : null}
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={innerH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${d.label}: ${unit(d.value)}`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="outline-none focus-visible:stroke-brand-500"
              />
              {i % labelEvery === 0 ? (
                <text
                  x={PAD.left + i * slot + slot / 2}
                  y={H - 8}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--chart-axis)"
                >
                  {d.short}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {a && active !== null ? (
        <div
          className="pointer-events-none absolute top-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md dark:border-slate-700 dark:bg-slate-900"
          style={{ left: `${Math.min(80, Math.max(0, ((PAD.left + active * slot) / W) * 100))}%` }}
          role="status"
        >
          <p className="font-medium">{a.label}</p>
          <p className="text-slate-600 dark:text-slate-300">{unit(a.value)}</p>
        </div>
      ) : null}
      <table className="sr-only">
        <caption>{caption}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
