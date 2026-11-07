import { createWebNotifications, type NotificationAdapter } from '@mawsool/ui';

/**
 * The phone's notification adapter: the browser's Notification API, shown through the service worker when one is
 * registered so the notification outlives the page. Browser only. Where notifications do not exist the adapter
 * reports `unsupported` and shows nothing.
 */
export async function deviceNotifications(): Promise<NotificationAdapter> {
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  return createWebNotifications(typeof Notification === 'undefined' ? undefined : Notification, registration ?? undefined);
}
