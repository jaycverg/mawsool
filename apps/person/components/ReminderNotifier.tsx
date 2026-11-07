'use client';

import { useDemoOffsetMs } from '@mawsool/ui/components';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { deviceNow } from '../lib/clock';
import { deviceNotifications } from '../lib/notify';
import { runDueReminder } from '../lib/reminders';
import { loadScreenings } from '../lib/screening-store';
import { getDevice } from '../lib/use-device';

/**
 * Shows the check-in reminder as a local notification when it is due. The browser cannot schedule one in the background,
 * so this runs when a page opens and again when the demo clock moves; the home screen's card carries the same reminder
 * for as long as it is due. Nothing here waits on the network, and a phone that cannot keep data simply never shows one.
 */
export function ReminderNotifier() {
  const t = useTranslations('reminder');
  const offset = useDemoOffsetMs();
  const title = t('title');
  const body = t('body');
  useEffect(() => {
    void (async () => {
      try {
        const { storage } = getDevice();
        await runDueReminder({ storage, notifications: await deviceNotifications(), screenings: await loadScreenings(storage), now: deviceNow, text: { title, body } });
      } catch {
        // No usable storage or notifications: the home screen's card still shows the reminder.
      }
    })();
  }, [offset, title, body]);
  return null;
}
