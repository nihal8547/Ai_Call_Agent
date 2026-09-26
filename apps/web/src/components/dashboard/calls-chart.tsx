"use client";

import { useState } from "react";
import { plural } from "@/lib/format";

type Point = { day: string; calls: number; booked: number };

const W = 720;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 36 };

function niceMax(n: number): number {
  if (n <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / step) * step;
}

const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: "UTC" }).format(
    new Date(Date.UTC(y!, m! - 1, d!)),
  );
};

/**
 * Calls per day: one series, so no legend box (the heading names it).
 * Bars ≤ 24px with a rounded data end, hairline grid, hover/focus tooltip, and a table for screen readers.
 */
export function CallsChart({ data }: { data: Point[] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...data.map((d) => d.calls)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.min(24, Math.max(2, slot - 2));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / 7);
  const a = active !== null ? data[active] : undefined;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Calls per day over the last ${data.length} days`}
      >
        {ticks.map((t) => (
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
          const h = Math.max(0, y(0) - y(d.calls));
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={d.day}>
              {h > 0 ? (
                <path
                  d={`M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
                  fill="var(--chart-bar)"
                  opacity={active === null || active === i ? 1 : 0.45}
                />
              ) : null}
              {/* Hit target: the whole column slot, bigger than the bar */}
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={innerH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${dayLabel(d.day, { day: "numeric", month: "short" })}: ${plural(d.calls, "call")}, ${d.booked} booked`}
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
                  {dayLabel(d.day, { day: "numeric", month: "short" })}
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
          <p className="font-medium">
            {dayLabel(a.day, { weekday: "short", day: "numeric", month: "short" })}
          </p>
          <p className="text-slate-600 dark:text-slate-300">{plural(a.calls, "call")}</p>
          <p className="text-slate-600 dark:text-slate-300">{a.booked.toLocaleString()} booked</p>
        </div>
      ) : null}
      <table className="sr-only">
        <caption>Calls per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Calls</th>
            <th>Booked</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.calls}</td>
              <td>{d.booked}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
