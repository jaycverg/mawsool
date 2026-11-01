import { Suspense } from 'react';
import { ResultScreen } from '../../../components/ResultScreen';
import { localeOf } from '../../../lib/locale-page';

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return (
    <Suspense>
      <ResultScreen />
    </Suspense>
  );
}
