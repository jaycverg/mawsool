import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppHeader, BrandMark, LanguageToggle, LocaleRedirect } from '../src/components';

describe('LanguageToggle', () => {
  it('links to the same page in the other locale, labelled in that language', () => {
    const html = renderToStaticMarkup(<LanguageToggle locale="en" ariaLabel="Language" />);
    expect(html).toContain('href="/ar/"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain('>عربي<');
    expect(html).toContain('aria-label="Language"');
  });

  it('offers English from the Arabic page', () => {
    const html = renderToStaticMarkup(<LanguageToggle locale="ar" ariaLabel="اللغة" />);
    expect(html).toContain('href="/en/"');
    expect(html).toContain('>English<');
  });

  it('has a tap target class and accepts a custom class', () => {
    const markup = renderToStaticMarkup(<LanguageToggle locale="en" ariaLabel="L" />);
    expect(markup).toContain('lang-toggle');
    expect(markup).toContain('tap');
    expect(renderToStaticMarkup(<LanguageToggle locale="en" ariaLabel="L" className="custom" />)).toContain('class="custom"');
  });
});

describe('LocaleRedirect', () => {
  it('renders plain links to both locales for visitors without scripts', () => {
    const html = renderToStaticMarkup(<LocaleRedirect />);
    expect(html).toContain('href="/en/"');
    expect(html).toContain('href="/ar/"');
  });
});

describe('AppHeader', () => {
  it('shows the two-ring mark, the wordmark and the language toggle, with 14 px of padding above and below', () => {
    const html = renderToStaticMarkup(<AppHeader locale="en" appName="Mawsool" languageLabel="Language" />);
    expect(html).toContain('<header');
    expect(html).toContain('py-3.5');
    expect(html.match(/<circle/g)).toHaveLength(2);
    expect(html).toContain('class="wordmark">Mawsool<');
    expect(html).toContain('lang-toggle');
  });

  it('puts the Arabic name and the English toggle in the Arabic header', () => {
    const html = renderToStaticMarkup(<AppHeader locale="ar" appName="موصول" languageLabel="اللغة" />);
    expect(html).toContain('>موصول<');
    expect(html).toContain('>English<');
  });

  it('draws the mark as the board does and hides it from assistive technology', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('viewBox="0 0 28 28"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('stroke-width="2.5"');
  });
});
