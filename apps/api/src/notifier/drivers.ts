import { createHmac } from 'node:crypto';
import { renderMessage, type Channel, type OutboundMessage, type RenderedMessage, type TemplateKey } from './templates';

/** The drivers there are. Both are mocks: nothing is sent by either. */
export const NOTIFIER_DRIVERS = ['console', 'log'] as const;
export type NotifierDriverName = (typeof NOTIFIER_DRIVERS)[number];

/** What a driver is told: the message, and the text a recipient would read. */
export interface Delivery {
  message: OutboundMessage;
  rendered: RenderedMessage;
}

/**
 * A way of "delivering" a message. Every driver here is a mock and says so; none sends anything, and none writes a phone number or
 * the text of a message that reaches a person. A link message (staff sign-in, clinic link) is the exception that is kept on
 * purpose: its link is what the presenter has to copy, so the link is logged, as it always was.
 */
export interface NotifierDriver {
  readonly name: NotifierDriverName;
  /** Says it is a mock, in the words a log line or a startup message can use. */
  readonly label: string;
  deliver(delivery: Delivery): Promise<void>;
}

/**
 * The reference a record carries for a person's text reminder: a keyed hash (HMAC-SHA256 under a key derived from the API's
 * encryption key, cut to 12 hex digits) of the **random id of the stored number's row**, never of the number. A number is a small
 * space that anyone holding the key could enumerate, so nothing here is computed from it: two records of one row carry the same
 * reference whatever number the row holds, a new row (a number removed and given again) gets a new one, and once the row is deleted
 * the reference maps to nothing. Staff and clinic link records carry no reference: their address, facility and ticket code are
 * written plainly, on purpose, beside the link.
 */
export function recipientRef(rowId: string, encryptionKey: string): string {
  const key = createHmac('sha256', Buffer.from(encryptionKey, 'base64')).update('notifier-recipient-v2').digest();
  return `rcp_${createHmac('sha256', key).update(rowId).digest('hex').slice(0, 12)}`;
}

/** What may be written about a delivery, and nothing else: the message text and a person's number are not among it. */
export interface DeliveryRecord {
  message: string;
  fields: { [key: string]: string | boolean };
}

const LINK_MESSAGES: { [K in TemplateKey]: string } = {
  staff_sign_in: 'staff sign-in link (logged, not sent)',
  clinic_link: 'clinic link (logged, not sent)',
  reminder_text: 'text reminder sample (mock: nothing sent)',
};

/**
 * The record of one delivery: the template key, the language, the channel and that it is a mock. A staff sign-in link adds the
 * address it was made for, the link and its expiry; a clinic link the facility, the ticket's code, the link and its expiry (the
 * link is logged on purpose). A text reminder adds only the reference of its stored number's row (`recipientRef`): not the number,
 * not the text, and nothing computed from the number.
 */
export function recordOf({ message, rendered }: Delivery, encryptionKey: string, driver: NotifierDriverName): DeliveryRecord {
  const fields: DeliveryRecord['fields'] = { driver, mock: true, template: rendered.template, locale: rendered.locale, channel: rendered.channel satisfies Channel };
  switch (message.template) {
    case 'staff_sign_in':
      return { message: LINK_MESSAGES.staff_sign_in, fields: { ...fields, to: message.to, link: message.link, expiresAt: message.expiresAt.toISOString() } };
    case 'clinic_link':
      return { message: LINK_MESSAGES.clinic_link, fields: { ...fields, facility: message.facility, ticketCode: message.ticketCode, link: message.link, expiresAt: message.expiresAt.toISOString() } };
    case 'reminder_text':
      return { message: LINK_MESSAGES.reminder_text, fields: { ...fields, recipientRef: recipientRef(message.recipientId, encryptionKey) } };
  }
}

interface LogLike {
  info(object: { [key: string]: unknown }, message: string): void;
}

/** Writes each record through the API's own logger, as one structured line. */
export function createLogDriver(log: LogLike, encryptionKey: string): NotifierDriver {
  return {
    name: 'log',
    label: 'log driver (mock: nothing is sent)',
    async deliver(delivery) {
      const record = recordOf(delivery, encryptionKey, 'log');
      log.info(record.fields, record.message);
    },
  };
}

/** Prints each record as one readable line on the process's output, for a presenter watching the terminal. */
export function createConsoleDriver(write: (line: string) => void, encryptionKey: string): NotifierDriver {
  return {
    name: 'console',
    label: 'console driver (mock: nothing is sent)',
    async deliver(delivery) {
      const record = recordOf(delivery, encryptionKey, 'console');
      write(`[mock notifier] ${record.message}: ${Object.entries(record.fields).map(([key, value]) => `${key}=${String(value)}`).join(' ')}\n`);
    },
  };
}

/** The notifier the rest of the API uses: every outbound message goes through `send`, which picks the template and hands it to the driver. */
export interface Notifier {
  send(message: OutboundMessage): Promise<void>;
}

export function createNotifier(driver: NotifierDriver): Notifier {
  return { send: (message) => driver.deliver({ message, rendered: renderMessage(message) }) };
}

/** Builds the driver a setting names. `NOTIFIER_DRIVER` is parsed strictly in `config.ts`, so only a name from `NOTIFIER_DRIVERS` arrives here. */
export function createDriver(name: NotifierDriverName, deps: { log: LogLike; encryptionKey: string; write?: (line: string) => void }): NotifierDriver {
  return name === 'console' ? createConsoleDriver(deps.write ?? ((line) => void process.stdout.write(line)), deps.encryptionKey) : createLogDriver(deps.log, deps.encryptionKey);
}
