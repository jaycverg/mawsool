import { Suspense } from 'react';
import { TammMock } from '../../../components/TammMock';
import { localeOf } from '../../../lib/locale-page';

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return (
    <Suspense>
      <TammMock />
    </Suspense>
  );
}
