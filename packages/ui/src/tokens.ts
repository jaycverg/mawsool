/** TypeScript mirror of `tokens.css`. A test keeps the two identical. */
export const COLORS = {
  ground: '#f3f6f5',
  surface: '#ffffff',
  ink: '#10302d',
  muted: '#4a5f5c',
  border: '#d5dfdc',
  accent: '#0e6b63',
  'accent-dark': '#0a4f49',
  'accent-tint': '#e0f0ec',
  danger: '#a61b1b',
  'crisis-ground': '#fbf4f2',
  warning: '#fdf3e4',
  'warning-ink': '#5c3a0a',
  mock: '#e7e4f2',
  'mock-ink': '#3e3470',
} as const;

export const RADII_PX = { card: 16, ticket: 18, staff: 14, input: 10, chip: 8 } as const;

/** Pill radii from the boards: 44 px controls and the 52 px call to action. */
export const PILL_RADII_PX = { control: 22, cta: 26 } as const;

export const TYPE = {
  h1: { sizePx: 24, lineHeightPx: { en: 30, ar: 34 }, weight: 600 },
  body: { sizePx: 15, lineHeightPx: { en: 22, ar: 24 } },
  small: { sizePx: 13 },
  label: { sizePx: 12 },
} as const;

export const FONT_FAMILIES = {
  sans: "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

/** Minimum tap target and call-to-action height. The boards' 36 and 40 px controls are raised to 44. */
export const TAP_TARGET_PX = 44;
export const CTA_HEIGHT_PX = 52;

/** The device width the layout and the computed-style assertions are checked at. */
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const;
