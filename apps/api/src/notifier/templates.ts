import type { Locale } from '@mawsool/types';

/**
 * Every message the API sends, by key. The MVP sends none of them: a mock driver records that one would have gone (see
 * `drivers.ts`). Each template has Arabic and English text; a recipient whose language is not known, or not one of these, is
 * served English.
 */
export const TEMPLATE_KEYS = ['staff_sign_in', 'clinic_link', 'reminder_text'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** How a message would reach its recipient: a sign-in link for staff, a link for a clinic, a text message for a person. */
export type Channel = 'staff_link' | 'clinic_link' | 'sms';

/** A staff member's sign-in link. */
export interface StaffSignInMessage {
  template: 'staff_sign_in';
  locale: string | null | undefined;
  to: string;
  link: string;
  expiresAt: Date;
}

/** A clinic's one-time link to one ticket. */
export interface ClinicLinkMessage {
  template: 'clinic_link';
  locale: string | null | undefined;
  /** The facility the link is for, so the log says whose it is. */
  facility: string;
  /** The ticket's short code. */
  ticketCode: string;
  link: string;
  expiresAt: Date;
}

/** The text reminder a person may ask for (a sample: nothing is sent). `to` is their number; no driver writes it anywhere. */
export interface ReminderTextMessage {
  template: 'reminder_text';
  locale: string | null | undefined;
  to: string;
}

export type OutboundMessage = StaffSignInMessage | ClinicLinkMessage | ReminderTextMessage;

/** The languages a template exists in. */
export const TEMPLATE_LOCALES: readonly Locale[] = ['ar', 'en'];

/** The language a message is written in: the recipient's when it is one of ours, English otherwise. */
export function templateLocale(requested: string | null | undefined): Locale {
  return (TEMPLATE_LOCALES as readonly string[]).includes(requested ?? '') ? (requested as Locale) : 'en';
}

interface Template<M extends OutboundMessage> {
  channel: Channel;
  /** Whether a person (not staff) reads it: such a template carries no clinical content, and a test bans the words in both languages. */
  personFacing: boolean;
  text: Record<Locale, (message: M) => string>;
}

type Templates = { [K in TemplateKey]: Template<Extract<OutboundMessage, { template: K }>> };

export const TEMPLATES: Templates = {
  staff_sign_in: {
    channel: 'staff_link',
    personFacing: false,
    text: {
      en: (m) => `Mawsool staff sign-in: open this link to sign in. It works once and expires at ${m.expiresAt.toISOString()}. ${m.link}`,
      ar: (m) => `تسجيل دخول موظفي موصول: افتح هذا الرابط لتسجيل الدخول. يعمل مرة واحدة وينتهي في ${m.expiresAt.toISOString()}. ${m.link}`,
    },
  },
  clinic_link: {
    channel: 'clinic_link',
    personFacing: false,
    text: {
      en: (m) => `Mawsool: a referral for ${m.facility} is waiting (${m.ticketCode}). Open this link to act on it. It works once and expires at ${m.expiresAt.toISOString()}. ${m.link}`,
      ar: (m) => `موصول: إحالة بانتظار ${m.facility} (${m.ticketCode}). افتح هذا الرابط للتصرف بشأنها. يعمل مرة واحدة وينتهي في ${m.expiresAt.toISOString()}. ${m.link}`,
    },
  },
  reminder_text: {
    channel: 'sms',
    personFacing: true,
    text: {
      en: () => 'Mawsool: time for your check-in. Open the app whenever you are ready.',
      ar: () => 'موصول: حان وقت فحصك. افتح التطبيق متى كنت مستعدًا.',
    },
  },
};

export interface RenderedMessage {
  template: TemplateKey;
  locale: Locale;
  channel: Channel;
  body: string;
}

/** The message as its recipient would read it, in the recipient's language (English when it is not one of ours). */
export function renderMessage(message: OutboundMessage): RenderedMessage {
  const locale = templateLocale(message.locale);
  const template = TEMPLATES[message.template] as Template<OutboundMessage>;
  return { template: message.template, locale, channel: template.channel, body: template.text[locale](message) };
}
