/** A source of "now". Every timestamp the app writes comes from one, so the demo clock can replace it in one place. */
export type Now = () => Date;

/** The device clock. */
export const deviceNow: Now = () => new Date();

export type NewId = () => string;
