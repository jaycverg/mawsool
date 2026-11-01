import type { Screening } from '@mawsool/types';
import { MAX_TOTAL } from '../lib/bands';

export interface TrendChartProps {
  /** Finished check-ins of one instrument, oldest first. */
  series: readonly Screening[];
  rtl: boolean;
  /** Accessible description of the whole chart. */
  label: string;
  /** Text for the first and last date under the line. */
  startLabel: string;
  endLabel: string;
  /** The home screen's sparkline is 64 px tall with no point values; the full chart is 150 px. */
  compact?: boolean;
}

const WIDTH = 320;
const FULL = { height: 150, pad: { left: 14, right: 14, top: 14, bottom: 14 } } as const;
const COMPACT = { height: 64, pad: { left: 8, right: 8, top: 8, bottom: 8 } } as const;

/**
 * A line of totals across check-ins. Time runs from the start edge, so the chart mirrors in Arabic. One point is a
 * dot with no line. The picture has a text description for screen readers, because the same facts are in the
 * check-in list and the result callout.
 */
export function TrendChart({ series, rtl, label, startLabel, endLabel, compact = false }: TrendChartProps) {
  if (series.length === 0) return null;
  const { height: HEIGHT, pad: PAD } = compact ? COMPACT : FULL;
  const instrument = series[0]!.instrument;
  const max = MAX_TOTAL[instrument];
  const first = Date.parse(series[0]!.takenAt);
  const last = Date.parse(series[series.length - 1]!.takenAt);
  const spanMs = last - first;
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  const points = series.map((screening, position) => {
    // One point sits in the middle; check-ins at the same instant are spread evenly; otherwise position follows time.
    const fraction = series.length === 1 ? 0.5 : spanMs === 0 ? position / (series.length - 1) : (Date.parse(screening.takenAt) - first) / spanMs;
    const x = PAD.left + (rtl ? 1 - fraction : fraction) * plotWidth;
    const y = PAD.top + (1 - screening.total / max) * plotHeight;
    return { x, y, total: screening.total };
  });

  return (
    <figure className="m-0 flex flex-col gap-1">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label} className="w-full" style={{ height: HEIGHT }} data-points={points.length}>
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={HEIGHT - PAD.bottom} y2={HEIGHT - PAD.bottom} stroke="#D5DFDC" strokeWidth="1" />
        {points.length > 1 && <polyline points={points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#0E6B63" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
        {points.map((p, position) => (
          <g key={position}>
            <circle cx={p.x} cy={p.y} r={position === points.length - 1 ? 5 : 3.5} fill={position === points.length - 1 ? '#0E6B63' : '#FFFFFF'} stroke="#0E6B63" strokeWidth="2" />
            {!compact && (
              <text x={p.x} y={Math.max(9, p.y - 9)} textAnchor="middle" fontSize="11" fill="#10302D">
                {p.total}
              </text>
            )}
          </g>
        ))}
      </svg>
      <figcaption className="flex justify-between text-[12px] text-muted">
        <span>{startLabel}</span>
        {series.length > 1 && <span>{endLabel}</span>}
      </figcaption>
    </figure>
  );
}
