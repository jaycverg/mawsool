export interface MagicLinkMessage {
  to: string;
  link: string;
  expiresAt: Date;
}

/**
 * Delivery of a staff sign-in link. The MVP never sends real mail or SMS: the shipped implementation writes
 * the link to the API log, where the presenter copies it.
 */
export interface MagicLinkNotifier {
  send(message: MagicLinkMessage): Promise<void>;
}

interface LogLike {
  info(object: Record<string, unknown>, message: string): void;
}

/** Logs the link. This is the "logged, not sent" behaviour the spec asks for. */
export class LogMagicLinkNotifier implements MagicLinkNotifier {
  constructor(private readonly log: LogLike) {}

  async send({ to, link, expiresAt }: MagicLinkMessage): Promise<void> {
    this.log.info({ to, link, expiresAt: expiresAt.toISOString() }, 'staff sign-in link (logged, not sent)');
  }

  async sendClinicLink({ facility, ticketCode, link, expiresAt }: ClinicLinkMessage): Promise<void> {
    this.log.info({ facility, ticketCode, link, expiresAt: expiresAt.toISOString() }, 'clinic link (logged, not sent)');
  }
}

export interface ClinicLinkMessage {
  /** The facility the link is for, so the log says whose it is. */
  facility: string;
  /** The ticket's short code. */
  ticketCode: string;
  link: string;
  expiresAt: Date;
}

/**
 * Delivery of a no-login clinic link, the second channel of the mock notifier: the MVP sends nothing, and the shipped
 * implementation writes the link to the API log. The link carries its token in the URL fragment, which a browser never sends.
 */
export interface ClinicLinkNotifier {
  sendClinicLink(message: ClinicLinkMessage): Promise<void>;
}

/** What the API's notifier does: both kinds of link. */
export type Notifier = MagicLinkNotifier & ClinicLinkNotifier;
