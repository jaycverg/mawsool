import { CheckInsScreen } from '../../../components/CheckInsScreen';
import { localeOf } from '../../../lib/locale-page';

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return <CheckInsScreen />;
}
