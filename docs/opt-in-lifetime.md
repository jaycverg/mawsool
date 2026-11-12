# How long an opt-in lives

Code: `apps/api/src/persons/last-seen.ts`, the sweep (`apps/api/src/sweep.ts`) and `OPT_IN_IDLE_LIMIT_DAYS` in `packages/rules/src/config.ts`; tests: `apps/api/test/opt-in-lifetime.test.ts`, `consent.test.ts` and `erase-reach.test.ts`.

A person who clears the browser's site data instead of using Delete everything loses the device secret, and with it the only way to turn their choices off. Without a limit their equity buckets and their anonymous-statistics opt-in would count for ever.

- **What is recorded.** `persons.last_seen_on`, a date with no time: the last UTC day on which a request authenticated as this person (and a repeat registration of the same device), on the wall clock. It is written by one guarded update that changes the row only when its day is older, so at most once a day per person; failing to authenticate writes nothing. A person who registered before the column existed was given the day of the migration. A seeded person has no date (no device), and is left alone.
- **What the sweep does.** For a person whose last day is `OPT_IN_IDLE_LIMIT_DAYS` (180, about six months) or more behind the wall-clock day, the sweep turns both opt-ins off and deletes the four equity buckets. The day the limit falls on counts: a person last seen 179 days ago keeps their choices, one last seen 180 days ago does not. It runs every minute with the other clean-ups.
- **Wall clock, not care clock.** A demo clock jump neither moves the date nor makes anyone look idle; the sweep reads the security clock for this, as it does for sessions and nonces.
- **Delete everything** clears the date with the rest (the person is gone from the device, so there is nothing to date).
- **What the person is told.** Settings says, beside each opt-in, in Arabic and English, that the choice turns itself off if this phone is not used for 6 months.
- **Not covered.** The phone is not told when the server turns a choice off. A phone that was silent for six months and is opened again may still show the choice as on until the person looks at Settings and turns it off; the server side is already off. A person who signs in again does not get their choices back.
