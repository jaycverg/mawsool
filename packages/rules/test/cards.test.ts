import { type Screening, type Tier } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { MAX_FIRST_VIEW_CARDS, match, splitCards } from '../src';
import { ONE_PER_TIER, gad7, phq9 } from './fixtures';

const run = (history: Screening[], currentTier: Tier | null = null, services = ONE_PER_TIER) =>
  splitCards(match(history, {}, 'daman_basic', 'abu_dhabi_city', services, { currentTier }));
const tiers = (options: { tier: string }[]) => options.map((o) => o.tier);

describe('splitCards', () => {
  it('allows three cards at first, as the spec says', () => {
    expect(MAX_FIRST_VIEW_CARDS).toBe(3);
  });

  it('shows the recommended tiers and keeps the rest behind "other options", least intensive first', () => {
    const { cards, others } = run([phq9(12)]);
    expect(tiers(cards)).toEqual(['gp', 'tele']);
    expect(tiers(others)).toEqual(['self_help', 'community', 'specialist']);
  });

  it('demo step 4: a trained GP, a tele session and the self-help the person is on', () => {
    const history = [gad7(9, '2026-10-08T08:00:00+04:00'), phq9(7, '2026-10-08T08:05:00+04:00'), gad7(14, '2026-10-29T08:00:00+04:00')];
    const { cards, others } = run(history, 'self_help');
    expect(tiers(cards)).toEqual(['gp', 'tele', 'self_help']);
    expect(cards.map((c) => c.current)).toEqual([false, false, true]);
    expect(tiers(others)).toEqual(['community', 'specialist']);
  });

  it('keeps the current tier ahead of the last recommended option when four would qualify', () => {
    const { cards, others } = run([phq9(21)], 'self_help');
    expect(tiers(cards)).toEqual(['specialist', 'gp', 'self_help']);
    expect(cards).toHaveLength(MAX_FIRST_VIEW_CARDS);
    expect(tiers(others)).toEqual(['tele', 'community']);
  });

  it('never drops the current tier, even when it is itself a recommended option', () => {
    const { cards } = run([phq9(21)], 'tele');
    expect(tiers(cards)).toEqual(['specialist', 'gp', 'tele']);
    expect(cards.filter((c) => c.current)).toHaveLength(1);
  });

  it('shows a lone recommended card for a top score with no current tier', () => {
    expect(tiers(run([phq9(21)]).cards)).toEqual(['specialist', 'gp', 'tele']);
    expect(tiers(run([]).cards)).toEqual(['self_help']);
  });

  it('shows the first ranked option when no recommended tier has a service', () => {
    const noSelfHelp = ONE_PER_TIER.filter((s) => s.tier !== 'self_help' && s.tier !== 'community');
    const { cards, others } = run([phq9(7)], null, noSelfHelp);
    expect(tiers(cards)).toEqual(['tele']);
    expect(tiers(others)).toEqual(['gp', 'specialist']);
  });

  it('is empty when there is nothing to show', () => {
    expect(run([phq9(7)], null, [])).toEqual({ cards: [], others: [] });
  });

  it('shows the crisis option alone', () => {
    const { cards, others } = run([phq9(5, '2026-10-01T08:00:00+04:00', 1)]);
    expect(tiers(cards)).toEqual(['crisis']);
    expect(others).toEqual([]);
  });

  it('honours a smaller maximum', () => {
    const options = match([phq9(21)], {}, 'daman_basic', 'abu_dhabi_city', ONE_PER_TIER, { currentTier: null });
    expect(tiers(splitCards(options, 2).cards)).toEqual(['specialist', 'gp']);
  });
});
