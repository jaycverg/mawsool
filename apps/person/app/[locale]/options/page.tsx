import { Suspense } from 'react';
import { OptionsScreen } from '../../../components/OptionsScreen';
import { localeOf } from '../../../lib/locale-page';

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return (
    <Suspense>
      <OptionsScreen />
    </Suspense>
  );
}
