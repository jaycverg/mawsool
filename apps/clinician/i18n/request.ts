import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, LOCALES, mergeMessages } from '@mawsool/ui';
import commonAr from '@mawsool/ui/messages/ar.json';
import commonEn from '@mawsool/ui/messages/en.json';
import appAr from '../messages/ar.json';
import appEn from '../messages/en.json';

const MESSAGES = {
  ar: mergeMessages(commonAr, appAr),
  en: mergeMessages(commonEn, appEn),
};

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(LOCALES, requested) ? requested : DEFAULT_LOCALE;
  return { locale, messages: MESSAGES[locale] };
});
