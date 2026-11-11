import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnonymousLeftNote } from '../components/AnonymousLeftNote';
import type { AnonymousLeft } from '../lib/device-data';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

const MESSAGES = { en, ar } as const;
const render = (locale: 'ar' | 'en', left: AnonymousLeft) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <AnonymousLeftNote left={left} />
    </NextIntlClientProvider>,
  );

describe('the note Delete everything shows when anonymous check-ins are left', () => {
  it('renders the next-start note, in each language, in its own words', () => {
    expect(render('en', 'next_start')).toContain(en.settings.deletedAnonymousLater);
    expect(render('ar', 'next_start')).toContain(ar.settings.deletedAnonymousLater);
    expect(render('en', 'next_start')).toContain('data-anonymous-left="next_start"');
  });

  it('renders the run-it-again note when even that cannot be promised, in each language', () => {
    expect(render('en', 'unknown')).toContain(en.settings.deletedAnonymousUnknown);
    expect(render('ar', 'unknown')).toContain(ar.settings.deletedAnonymousUnknown);
    expect(render('en', 'unknown')).toContain('data-anonymous-left="unknown"');
  });

  it('says nothing when nothing is left, and the two notes and the two languages are four different texts, the Arabic in Arabic script', () => {
    expect(render('en', 'none')).toBe('');
    expect(render('ar', 'none')).toBe('');
    const texts = [en.settings.deletedAnonymousLater, en.settings.deletedAnonymousUnknown, ar.settings.deletedAnonymousLater, ar.settings.deletedAnonymousUnknown];
    expect(new Set(texts).size).toBe(4);
    for (const arabic of [ar.settings.deletedAnonymousLater, ar.settings.deletedAnonymousUnknown]) expect(arabic).toMatch(/[؀-ۿ]/);
    expect(en.settings.deletedAnonymousUnknown).toMatch(/again/);
  });
});
