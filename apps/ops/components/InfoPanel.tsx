'use client';

import { METRIC_DEFINITIONS, type MetricDefinitionId } from '@mawsool/types';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

/** The definition of a dashboard tile or section, by its id. Throws for an id nobody defined, which a test also catches. */
function definitionOf(id: MetricDefinitionId) {
  const definition = METRIC_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`No metric definition for "${id}"`);
  return definition;
}

/**
 * The info panel of one tile or section: a button that opens its exact definition, its numerator, its denominator, its period and
 * how it is suppressed. A disclosure, so it opens with the keyboard (Enter, Space) and by touch, a screen reader hears it as a
 * button that is collapsed or expanded, Escape closes it from inside, and it lays out with logical properties so it reads
 * right in Arabic. The wording is in the message files (`defs.<id>`), the machine-readable side in `METRIC_DEFINITIONS`.
 *
 * `label` is the name of the figure it explains, so the button's spoken name says which one.
 */
export function InfoPanel({ id, label }: { id: MetricDefinitionId; label: string }) {
  const t = useTranslations('defs');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonId = useId();
  const definition = definitionOf(id);
  return (
    <div className="flex flex-col gap-1.5" data-info={id}>
      <button
        id={buttonId}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${t('toggle')}: ${label}`}
        onClick={() => setOpen((current) => !current)}
        className="tap inline-flex items-center gap-1.5 self-start rounded-pill border border-[#9AAAA7] bg-surface px-3 text-[13px] font-semibold text-ink"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="flex-none">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.5" />
        </svg>
        <span>{t('toggle')}</span>
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setOpen(false);
            document.getElementById(buttonId)?.focus();
          }}
          className="flex flex-col gap-2 rounded-input bg-ground p-3 text-start text-[13px] leading-5"
          data-info-panel={id}
        >
          <dl className="m-0 flex flex-col gap-2">
            <Part term={t('definitionLabel')} text={t(`${id}.definition`)} part="definition" />
            <Part term={t('numeratorLabel')} text={t(`${id}.numerator`)} part="numerator" />
            <Part term={t('denominatorLabel')} text={t(`${id}.denominator`)} part="denominator" />
            <Part term={t('periodLabel')} text={t(`period.${definition.period}`)} part="period" />
            <Part term={t('suppressionLabel')} text={t(`suppression.${definition.suppression}`)} part="suppression" />
          </dl>
          <button
            type="button"
            className="tap self-start rounded-pill border border-border px-3 text-[13px] font-semibold"
            onClick={() => {
              setOpen(false);
              document.getElementById(buttonId)?.focus();
            }}
          >
            {t('close')}
          </button>
        </div>
      )}
    </div>
  );
}

function Part({ term, text, part }: { term: string; text: string; part: string }) {
  return (
    <div data-info-part={part}>
      <dt className="font-semibold text-muted">{term}</dt>
      <dd className="m-0">{text}</dd>
    </div>
  );
}
