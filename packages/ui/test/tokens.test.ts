import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLORS, CTA_HEIGHT_PX, RADII_PX, TAP_TARGET_PX, TYPE } from '../src';

const css = readFileSync(join(__dirname, '..', 'src', 'tokens.css'), 'utf8');
const declared = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();

describe('design tokens match the boards', () => {
  // Written out from the plan's token list, not derived from tokens.ts, so a typo in both files still fails.
  const fromPlan: Record<string, string> = {
    ground: '#F3F6F5',
    surface: '#FFFFFF',
    ink: '#10302D',
    muted: '#4A5F5C',
    border: '#D5DFDC',
    accent: '#0E6B63',
    'accent-dark': '#0A4F49',
    'accent-tint': '#E0F0EC',
    danger: '#A61B1B',
    'crisis-ground': '#FBF4F2',
    warning: '#FDF3E4',
    'warning-ink': '#5C3A0A',
    mock: '#E7E4F2',
    'mock-ink': '#3E3470',
  };

  it.each(Object.entries(fromPlan))('color %s is %s in the CSS and in tokens.ts', (name, hex) => {
    expect(declared(`color-${name}`)?.toUpperCase()).toBe(hex);
    expect(COLORS[name as keyof typeof COLORS].toUpperCase()).toBe(hex);
  });

  it('has exactly the plan colors and no others', () => {
    const names = [...css.matchAll(/--color-([a-z-]+):/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(Object.keys(fromPlan)));
    expect(Object.keys(COLORS).sort()).toEqual(Object.keys(fromPlan).sort());
  });

  it('has the radii 16, 18 ticket, 14 staff, 10 input, 8 chip', () => {
    expect(RADII_PX).toEqual({ card: 16, ticket: 18, staff: 14, input: 10, chip: 8 });
    for (const [name, px] of Object.entries(RADII_PX)) expect(declared(`radius-${name}`)).toBe(`${px}px`);
  });

  it('has h1 24/30 weight 600 and Arabic 24/34, body 15/22 and Arabic 15/24, small 13, label 12', () => {
    expect(TYPE.h1).toEqual({ sizePx: 24, lineHeightPx: { en: 30, ar: 34 }, weight: 600 });
    expect(TYPE.body).toEqual({ sizePx: 15, lineHeightPx: { en: 22, ar: 24 } });
    expect(declared('text-h1')).toBe('24px');
    expect(declared('text-h1--line-height')).toBe('30px');
    expect(declared('text-body')).toBe('15px');
    expect(declared('text-body--line-height')).toBe('22px');
    expect(declared('text-small')).toBe('13px');
    expect(declared('text-label')).toBe('12px');
    const arabic = /html\[lang='ar'\]\s*{([^}]*)}/.exec(css)?.[1] ?? '';
    expect(arabic).toMatch(/--text-h1--line-height:\s*34px/);
    expect(arabic).toMatch(/--text-body--line-height:\s*24px/);
    expect(css).toMatch(/\.t-h1\s*{[^}]*font-weight:\s*600/);
  });

  it('sets tap targets at 44 and calls to action at 52', () => {
    expect([TAP_TARGET_PX, CTA_HEIGHT_PX]).toEqual([44, 52]);
    expect(declared('spacing-tap')).toBe('44px');
    expect(declared('spacing-cta')).toBe('52px');
  });

  it('names IBM Plex Sans, IBM Plex Sans Arabic and IBM Plex Mono', () => {
    expect(declared('font-sans')).toContain("'IBM Plex Sans'");
    expect(declared('font-sans')).toContain("'IBM Plex Sans Arabic'");
    expect(declared('font-mono')).toContain("'IBM Plex Mono'");
  });

  it('self-hosts the fonts, weights 400-700 for sans and Arabic and 500-600 for mono', () => {
    const fonts = readFileSync(join(__dirname, '..', 'src', 'fonts.css'), 'utf8');
    for (const w of [400, 500, 600, 700]) {
      expect(fonts).toContain(`@fontsource/ibm-plex-sans/${w}.css`);
      expect(fonts).toContain(`@fontsource/ibm-plex-sans-arabic/${w}.css`);
    }
    for (const w of [500, 600]) expect(fonts).toContain(`@fontsource/ibm-plex-mono/${w}.css`);
    expect(fonts).not.toMatch(/https?:/);
  });

  it('mirrors directional icons in right-to-left layouts', () => {
    expect(css).toMatch(/\[dir='rtl'\]\s*\.rtl-flip\s*{[^}]*scaleX\(-1\)/);
  });
});
