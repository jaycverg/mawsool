import { AnonymousScreen } from '../../../components/AnonymousScreen';
import { localeOf } from '../../../lib/locale-page';

/** What anonymous mode is, and how to start or leave it. It reads only this tab's own mark, so it opens offline. */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return <AnonymousScreen />;
}
