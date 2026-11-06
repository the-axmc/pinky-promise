/**
 * The two charts of the page.
 *
 * ReadingStrip is what anyone can see: one mark per reading, in order, saying only whether it
 * was within limits — that is all the public record holds. TemperatureChart appears once the
 * episode logs are unlocked with the view key and shows the values themselves.
 *
 * Both follow the same rules: state is carried by shape and label as well as colour, text uses
 * text colours, there is one y-axis, and every mark answers a hover with its details. The
 * readings table below them is the table view of the same data.
 */
import { useState } from 'react';
import { celsius, clock, percent } from '../lib/format';

type StripReading = { seq: number; ts: number; inRange: boolean; venueName?: string; hasProof: boolean };
type StripHandoff = { seq: number; label: string };

export function ReadingStrip({ readings, handoffs }: { readings: StripReading[]; handoffs: StripHandoff[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (readings.length === 0) return <p className="muted">No readings yet.</p>;

  // Readings and handoffs share one sequence, so order them together on an even grid.
  const slots = [...readings.map((r) => ({ seq: r.seq, kind: 'reading' as const })), ...handoffs.map((h) => ({ seq: h.seq, kind: 'handoff' as const }))].sort(
    (a, b) => a.seq - b.seq,
  );
  const step = 34;
  const left = 20;
  const width = left * 2 + Math.max(1, slots.length - 1) * step;
  const xOf = (seq: number) => left + slots.findIndex((slot) => slot.seq === seq) * step;
  const active = hover === null ? undefined : readings.find((r) => r.seq === hover);

  return (
    <figure className="viz">
      <div className="viz-scroll">
        <svg viewBox={`0 0 ${width} 86`} width={width} height={86} role="img" aria-label={`${readings.length} readings in order; ${readings.filter((r) => !r.inRange).length} outside limits`}>
          <line x1={left} x2={width - left} y1={52} y2={52} className="viz-axis" />
          {handoffs.map((handoff) => (
            <g key={`h${handoff.seq}`}>
              <line x1={xOf(handoff.seq)} x2={xOf(handoff.seq)} y1={20} y2={64} className="viz-handoff" />
              <text x={xOf(handoff.seq)} y={14} textAnchor="middle" className="viz-label">
                {handoff.label}
              </text>
            </g>
          ))}
          {readings.map((reading) => {
            const x = xOf(reading.seq);
            return (
              <g key={reading.seq} onMouseEnter={() => setHover(reading.seq)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(reading.seq)} onBlur={() => setHover(null)} tabIndex={0}>
                {/* The hit target is larger than the mark. */}
                <rect x={x - step / 2} y={26} width={step} height={56} fill="transparent" />
                {reading.inRange ? (
                  <circle cx={x} cy={52} r={hover === reading.seq ? 7 : 5.5} className="mark-good" />
                ) : (
                  <g className="mark-critical">
                    <circle cx={x} cy={52} r={hover === reading.seq ? 9 : 8} />
                    <path d={`M${x - 3.5} ${52 - 3.5} L${x + 3.5} ${52 + 3.5} M${x + 3.5} ${52 - 3.5} L${x - 3.5} ${52 + 3.5}`} />
                  </g>
                )}
                {reading.hasProof ? <rect x={x - 3} y={34} width={6} height={6} rx={1} className="mark-proof" /> : null}
                <text x={x} y={78} textAnchor="middle" className="viz-tick">
                  {reading.seq}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="viz-legend">
        <span>
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" className="mark-good" />
          </svg>
          within limits
        </span>
        <span>
          <svg width="18" height="18" aria-hidden="true">
            <g className="mark-critical">
              <circle cx="9" cy="9" r="8" />
              <path d="M5.5 5.5 L12.5 12.5 M12.5 5.5 L5.5 12.5" />
            </g>
          </svg>
          outside limits
        </span>
        <span>
          <svg width="10" height="10" aria-hidden="true">
            <rect x="2" y="2" width="6" height="6" rx="1" className="mark-proof" />
          </svg>
          has a geofence proof
        </span>
        <span className="viz-readout" aria-live="polite">
          {active
            ? `#${active.seq} · ${clock(active.ts)} · ${active.inRange ? 'within limits' : 'OUTSIDE limits'}${active.venueName ? ` · at ${active.venueName}` : ''}`
            : 'hover a reading for details'}
        </span>
      </figcaption>
    </figure>
  );
}

type RawPoint = { seq: number; ts: number; tempCenti: number; rhCenti: number };

export function TemperatureChart({ points, minCenti, maxCenti }: { points: RawPoint[]; minCenti: number; maxCenti: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;

  const width = 720;
  const height = 240;
  const pad = { left: 44, right: 64, top: 16, bottom: 30 };
  const temps = points.map((p) => p.tempCenti);
  const low = Math.min(minCenti, ...temps) - 100;
  const high = Math.max(maxCenti, ...temps) + 100;
  const x = (index: number) => pad.left + (points.length === 1 ? 0.5 : index / (points.length - 1)) * (width - pad.left - pad.right);
  const y = (centi: number) => pad.top + (1 - (centi - low) / (high - low)) * (height - pad.top - pad.bottom);
  const outside = (p: RawPoint) => p.tempCenti < minCenti || p.tempCenti > maxCenti;
  const ticks: number[] = [];
  for (let value = Math.ceil(low / 200) * 200; value <= high; value += 200) ticks.push(value);
  const active = hover === null ? undefined : points[hover];

  return (
    <figure className="viz">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={`Temperature of ${points.length} readings against the allowed ${celsius(minCenti)} to ${celsius(maxCenti)}`}>
        {/* The allowed band: neutral, behind everything, labelled at its edges. */}
        <rect x={pad.left} y={y(maxCenti)} width={width - pad.left - pad.right} height={y(minCenti) - y(maxCenti)} className="viz-band" />
        {ticks.map((value) => (
          <g key={value}>
            <line x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} className="viz-grid" />
            <text x={pad.left - 8} y={y(value) + 4} textAnchor="end" className="viz-tick">
              {value / 100}°
            </text>
          </g>
        ))}
        <text x={width - pad.right + 6} y={y(maxCenti) + 4} className="viz-label">
          max {celsius(maxCenti)}
        </text>
        <text x={width - pad.right + 6} y={y(minCenti) + 4} className="viz-label">
          min {celsius(minCenti)}
        </text>
        <polyline points={points.map((p, i) => `${x(i)},${y(p.tempCenti)}`).join(' ')} className="viz-line" />
        {active && hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={height - pad.bottom} className="viz-crosshair" /> : null}
        {points.map((p, i) =>
          outside(p) ? (
            <g key={p.seq} className="mark-critical">
              <circle cx={x(i)} cy={y(p.tempCenti)} r={8} />
              <path d={`M${x(i) - 3.5} ${y(p.tempCenti) - 3.5} l7 7 m0 -7 l-7 7`} />
              <text x={x(i)} y={y(p.tempCenti) - 13} textAnchor="middle" className="viz-value">
                {celsius(p.tempCenti)}
              </text>
            </g>
          ) : (
            <circle key={p.seq} cx={x(i)} cy={y(p.tempCenti)} r={hover === i ? 5.5 : 4} className="viz-point" />
          ),
        )}
        {points.map((p, i) => (
          <g key={`t${p.seq}`}>
            <text x={x(i)} y={height - 10} textAnchor="middle" className="viz-tick">
              #{p.seq}
            </text>
            <rect
              x={x(i) - 16}
              y={pad.top}
              width={32}
              height={height - pad.top - pad.bottom}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          </g>
        ))}
      </svg>
      <figcaption className="viz-legend">
        <span className="viz-readout" aria-live="polite">
          {active
            ? `#${active.seq} · ${clock(active.ts)} · ${celsius(active.tempCenti)} · ${percent(active.rhCenti)} RH · ${outside(active) ? 'OUTSIDE limits' : 'within limits'}`
            : 'hover the chart for each reading'}
        </span>
      </figcaption>
    </figure>
  );
}
