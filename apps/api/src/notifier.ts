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
}
