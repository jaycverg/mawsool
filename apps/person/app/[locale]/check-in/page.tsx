import { Suspense } from 'react';
import { CheckInFlow } from '../../../components/CheckInFlow';
import { localeOf } from '../../../lib/locale-page';

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return (
    <Suspense>
      <CheckInFlow />
    </Suspense>
  );
}
