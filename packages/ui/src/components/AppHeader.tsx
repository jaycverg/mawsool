import type { Locale } from '@mawsool/types';
import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { LanguageToggle } from './LanguageToggle';

export interface AppHeaderProps {
  locale: Locale;
  /** The product name in the page language. */
  appName: string;
  /** Accessible name of the language toggle. */
  languageLabel: string;
  /** Sits after the language toggle, such as the person app's "Help now" pill. */
  action?: ReactNode;
}

/**
 * The header every screen carries, from the person-app boards: the two-ring mark, the wordmark and the language
 * toggle, 14 px above and below the 44 px controls, which makes the bar 73 px with its 1 px rule.
 */
export function AppHeader({ locale, appName, languageLabel, action }: AppHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-2 border-b border-border bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2">
        <BrandMark />
        <span className="wordmark">{appName}</span>
      </div>
      <div className="flex items-center gap-2">
        <LanguageToggle locale={locale} ariaLabel={languageLabel} />
        {action}
      </div>
    </header>
  );
}
