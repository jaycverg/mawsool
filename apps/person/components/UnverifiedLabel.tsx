'use client';

import { useTranslations } from 'next-intl';

/**
 * The visible label for wording that has not been verified against a validated published form. It is shown with
 * every question and result whose `wordingStatus` is `unverified`, so a score is never read as more trustworthy
 * than its wording.
 */
export function UnverifiedLabel({ compact = false }: { compact?: boolean }) {
  const t = useTranslations(compact ? 'result' : 'wording');
  return (
    <p role="note" data-wording="unverified" className="rounded-chip bg-warning px-3 py-2 text-small text-warning-ink">
      {compact ? (
        t('unverified')
      ) : (
        <>
          <strong className="font-semibold">{t('unverifiedTitle')}</strong>
          {' · '}
          {t('unverifiedBody')}
        </>
      )}
    </p>
  );
}
