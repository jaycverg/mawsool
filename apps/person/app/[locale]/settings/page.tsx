import { SettingsScreen } from '../../../components/SettingsScreen';
import { localeOf } from '../../../lib/locale-page';

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await localeOf(params);
  return <SettingsScreen />;
}
