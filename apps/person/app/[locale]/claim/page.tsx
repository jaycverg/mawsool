import { Suspense } from 'react';
import { ClaimScreen } from '../../../components/ClaimScreen';
import { localeOf } from '../../../lib/locale-page';

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return (
    <Suspense>
      <ClaimScreen />
    </Suspense>
  );
}
