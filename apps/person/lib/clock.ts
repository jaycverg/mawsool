import { demoNow } from '@mawsool/ui';

/** A source of "now". Every timestamp the app writes comes from one, so the demo clock can replace it in one place. */
export type Now = () => Date;

/**
 * The device clock plus the demo clock's offset (zero unless a demo is running; see `lib/demo-offset.ts`). Check-in
 * dates, choice times and the ticket's countdown all read it, so they agree with the API about the date.
 */
export const deviceNow: Now = () => demoNow();

export type NewId = () => string;
