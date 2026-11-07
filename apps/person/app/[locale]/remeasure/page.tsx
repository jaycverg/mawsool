import { Suspense } from 'react';
import { RemeasureScreen } from '../../../components/RemeasureScreen';
import { localeOf } from '../../../lib/locale-page';

/** The repeat check at six weeks, addressed by query string like the ticket: `/[locale]/remeasure/?id=<ticket>&p=<PHQ-9>&g=<GAD-7>`. */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return (
    <Suspense>
      <RemeasureScreen />
    </Suspense>
  );
}
