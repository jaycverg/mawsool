'use client';

import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';

/** Reads the ticket id from the query string. The ticket view itself arrives with the closed-loop screens. */
export function TicketLookup() {
  const t = useTranslations('ticket');
  const id = useSearchParams().get('id');
  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 p-4">
      <h1 className="t-h1">{t('heading')}</h1>
      {id ? (
        <p className="t-body">
          {t('idLabel')} · <span className="t-code">{id}</span>
        </p>
      ) : (
        <p className="t-body">{t('noId')}</p>
      )}
    </main>
  );
}
