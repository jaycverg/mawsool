import type { BundleContent } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { QUEUE_TIERS, addressQuery, deadlineOf, displayCode, queueQuery, sparkline, ticketIdFromQuery, trajectoryByInstrument, viewFromQuery } from '../lib/queue';

const params = (query: string) => new URLSearchParams(query);
const ID = '5b5d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a11';

describe('the queue view in the address', () => {
  it('reads a state and a tier, and falls back to all open and no tier for anything unknown', () => {
    expect(viewFromQuery(params('state=overdue&tier=gp'))).toEqual({ state: 'overdue', tier: 'gp' });
    expect(viewFromQuery(params(''))).toEqual({ state: 'open', tier: null });
    expect(viewFromQuery(params('state=sort-of-open&tier=gold'))).toEqual({ state: 'open', tier: null });
  });

  it('offers no queue for guided self-help, which never becomes a ticket', () => {
    expect(QUEUE_TIERS).not.toContain('self_help');
    expect(viewFromQuery(params('tier=self_help')).tier).toBeNull();
  });

  it('builds the API query with the state, the page size and the tier only when there is one', () => {
    expect(queueQuery({ state: 'open', tier: null })).toBe('?state=open&limit=200');
    expect(queueQuery({ state: 'seen', tier: 'tele' }, 50)).toBe('?state=seen&limit=50&tier=tele');
  });

  it('writes the address leaving out defaults, and keeps the open ticket', () => {
    expect(addressQuery({ state: 'open', tier: null }, null)).toBe('');
    expect(addressQuery({ state: 'overdue', tier: 'gp' }, ID)).toBe(`?state=overdue&tier=gp&ticket=${ID}`);
    expect(addressQuery({ state: 'open', tier: null }, ID)).toBe(`?ticket=${ID}`);
  });

  it('takes a ticket id from the address only when it is a UUID, so nothing else reaches an API path', () => {
    expect(ticketIdFromQuery(params(`ticket=${ID}`))).toBe(ID);
    for (const bad of ['', '../x', 'abc', `${ID}/bundle`, `${ID}?x=1`]) expect(ticketIdFromQuery(params(`ticket=${encodeURIComponent(bad)}`)), bad).toBeNull();
    expect(ticketIdFromQuery(params(''))).toBeNull();
  });

  it('shows a ticket code with a dash', () => {
    expect(displayCode('MW4K7Q')).toBe('MW-4K7Q');
  });
});

describe('the deadline', () => {
  it('reads as days left, zero meaning today, or days late', () => {
    expect(deadlineOf(4)).toEqual({ kind: 'left', days: 4 });
    expect(deadlineOf(0)).toEqual({ kind: 'left', days: 0 });
    expect(deadlineOf(-1)).toEqual({ kind: 'late', days: 1 });
  });
});

describe('the trajectory', () => {
  const entry = (instrument: 'phq9' | 'gad7', total: number, takenAt: string) => ({ instrument, total, band: null, takenAt });
  const content: BundleContent = {
    trajectory: [entry('gad7', 14, '2026-10-29T08:00:00+04:00'), entry('phq9', 7, '2026-10-29T08:05:00+04:00'), entry('gad7', 9, '2026-10-08T08:00:00+04:00')],
  };

  it('groups by instrument in the order they first appear, each oldest first', () => {
    const series = trajectoryByInstrument(content);
    expect(series.map((s) => s.instrument)).toEqual(['gad7', 'phq9']);
    expect(series[0]!.entries.map((e) => e.total)).toEqual([9, 14]);
  });

  it('is empty when nothing was shared', () => {
    expect(trajectoryByInstrument({})).toEqual([]);
  });

  it('draws a line that rises with the total and runs forward in time', () => {
    const [gad] = trajectoryByInstrument(content);
    const points = sparkline(gad!.entries, 72, 28).split(' ').map((p) => p.split(',').map(Number) as [number, number]);
    expect(points).toHaveLength(2);
    expect(points[0]![0]).toBeLessThan(points[1]![0]);
    expect(points[0]![1]).toBeGreaterThan(points[1]![1]); // SVG y grows downward: a higher total is higher on the page
  });

  it('puts a single value in the middle, a flat series level, and same-instant entries side by side', () => {
    const one = entry('gad7', 9, '2026-10-08T08:00:00+04:00');
    expect(sparkline([one], 72, 28)).toBe('36.0,14.0');
    const flat = sparkline([one, entry('gad7', 9, '2026-10-09T08:00:00+04:00')], 72, 28).split(' ');
    expect(new Set(flat.map((p) => p.split(',')[1])).size).toBe(1);
    const same = sparkline([one, entry('gad7', 12, '2026-10-08T08:00:00+04:00')], 72, 28).split(' ').map((p) => Number(p.split(',')[0]));
    expect(same[0]).toBeLessThan(same[1]!);
    expect(sparkline([], 72, 28)).toBe('');
  });
});
