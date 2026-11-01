import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LanguageToggle, LocaleRedirect } from '../src/components';

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
    expect(renderToStaticMarkup(<LanguageToggle locale="en" ariaLabel="L" />)).toContain('tap');
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
