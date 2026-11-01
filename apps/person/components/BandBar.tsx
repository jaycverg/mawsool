import type { Instrument } from '@mawsool/types';
import { BAND_SEGMENTS, markerFraction } from '../lib/bands';

export interface BandBarProps {
  instrument: Instrument;
  total: number;
  /** Band id to its printed name. */
  names: Record<string, string>;
  /** Id of the band the total falls in; its name is shown in full strength. */
  current: string | null;
}

/**
 * The severity bar from the Result board: one segment per band, widths in score values, a marker where the total
 * sits and the band names beneath. It lays out along the inline axis, so it mirrors in right-to-left layouts. The
 * WHO-5 has no bands and shows a plain track with the marker.
 */
export function BandBar({ instrument, total, names, current }: BandBarProps) {
  const segments = BAND_SEGMENTS[instrument];
  const percent = `${Math.round(markerFraction(instrument, total) * 1000) / 10}%`;
  return (
    <div className="relative pt-3.5" data-band={current ?? undefined}>
      <div className="flex h-3 gap-[3px]" aria-hidden="true">
        {segments ? (
          segments.map((segment, position) => (
            <div
              key={segment.id}
              className={position === 0 ? 'rounded-s-[6px]' : position === segments.length - 1 ? 'rounded-e-[6px]' : ''}
              style={{ flex: segment.values, background: segment.color }}
            />
          ))
        ) : (
          <div className="flex-1 rounded-[6px] bg-border" />
        )}
      </div>
      <div className="absolute top-0 h-[30px] w-1 rounded-sm bg-ink" style={{ insetInlineStart: percent, marginInlineStart: -2 }} aria-hidden="true" />
      {segments && (
        <div className="mt-2 flex gap-[3px] text-[12px] text-muted">
          {segments.map((segment) => (
            <span key={segment.id} className={segment.id === current ? 'font-semibold text-ink' : undefined} style={{ flex: segment.values }}>
              {names[segment.id]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
