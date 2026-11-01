import { HomeScreen } from '../../components/HomeScreen';
import { localeOf } from '../../lib/locale-page';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return <HomeScreen />;
}
