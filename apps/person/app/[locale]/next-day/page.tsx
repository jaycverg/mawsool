import { NextDayScreen } from '../../../components/NextDayScreen';
import { localeOf } from '../../../lib/locale-page';

/** The next-day check after a crisis. It reads only the phone's own record, so it opens offline. */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return <NextDayScreen />;
}
