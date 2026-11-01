export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface LocalNotification {
  title: string;
  body?: string;
  tag?: string;
}

/** Local notifications, such as the day-7 check. The web version uses the Notification API. */
export interface NotificationAdapter {
  permission(): NotificationPermissionState;
  requestPermission(): Promise<NotificationPermissionState>;
  show(notification: LocalNotification): Promise<void>;
}

interface NotificationLike {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: { body?: string; tag?: string }): unknown;
}

interface RegistrationLike {
  showNotification(title: string, options?: { body?: string; tag?: string }): Promise<void>;
}

/**
 * Web notifications. Pass the browser's `Notification` (or undefined where it does not exist) and, when a
 * service worker is registered, its registration so the notification outlives the page.
 */
export function createWebNotifications(
  notification: NotificationLike | undefined,
  registration?: RegistrationLike,
): NotificationAdapter {
  return {
    permission: () => (notification ? notification.permission : 'unsupported'),
    async requestPermission() {
      return notification ? notification.requestPermission() : 'unsupported';
    },
    async show({ title, body, tag }) {
      if (!notification || notification.permission !== 'granted') return;
      if (registration) await registration.showNotification(title, { body, tag });
      else new notification(title, { body, tag });
    },
  };
}
