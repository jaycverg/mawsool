'use client';

import { useDemoOffsetMs } from '@mawsool/ui/components';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { deviceNow } from '../lib/clock';
import { deviceNotifications } from '../lib/notify';
import { runDueFollowUp } from '../lib/follow-up';
import { runDueReminder } from '../lib/reminders';
import { loadScreenings } from '../lib/screening-store';
import { getDevice } from '../lib/use-device';

/**
 * Shows the check-in reminder, and the next-day check after a crisis, as local notifications when they are due. The browser cannot schedule one in the background,
 * so this runs when a page opens and again when the demo clock moves; the home screen's card carries the same reminder
 * for as long as it is due. Nothing here waits on the network, and a phone that cannot keep data simply never shows one.
 */
export function ReminderNotifier() {
  const t = useTranslations('reminder');
  const tn = useTranslations('nextDay');
  const offset = useDemoOffsetMs();
  const title = t('title');
  const body = t('body');
  const nextDayTitle = tn('notifyTitle');
  const nextDayBody = tn('notifyBody');
  useEffect(() => {
    void (async () => {
      try {
        const { storage } = getDevice();
        const notifications = await deviceNotifications();
        // Each runs on its own: a failure of one never keeps the other from showing.
        await runDueFollowUp({ storage, notifications, now: deviceNow, text: { title: nextDayTitle, body: nextDayBody } }).catch(() => undefined);
        await runDueReminder({ storage, notifications, screenings: await loadScreenings(storage), now: deviceNow, text: { title, body } }).catch(() => undefined);
      } catch {
        // No usable storage or notifications: the home screen's cards still show them.
      }
    })();
  }, [offset, title, body, nextDayTitle, nextDayBody]);
  return null;
}
