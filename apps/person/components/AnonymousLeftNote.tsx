import { useTranslations } from 'next-intl';
import type { AnonymousLeft } from '../lib/device-data';

/**
 * What "Delete everything" says when an anonymous session's check-ins could not be deleted just now: that they are removed at the
 * next start of the app, or, when even that cannot be promised, that Delete everything should be run again. Nothing when none is left.
 */
export function AnonymousLeftNote({ left }: { left: AnonymousLeft }) {
  const t = useTranslations('settings');
  if (left === 'none') return null;
  return (
    <p className="t-small text-muted" data-anonymous-left={left}>
      {t(left === 'next_start' ? 'deletedAnonymousLater' : 'deletedAnonymousUnknown')}
    </p>
  );
}
