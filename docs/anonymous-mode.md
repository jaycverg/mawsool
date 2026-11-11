# Anonymous mode

The person app's anonymous mode (`apps/person/lib/anonymous.ts`) is a session that makes no request to the server and keeps
nothing on one. It is chosen and left on `/anonymous`, and lasts as long as the browser tab.

## What leaves the phone

Nothing. `deviceFetch()` (`lib/net.ts`) is the only `fetch` the app uses, and in the mode it refuses before anything leaves the
phone; a source scan fails when any other file names the network. Background jobs return before they open a store. There is
no registration, directory fetch, clock read, crisis event or hand-off, so an anonymous crisis is not on the ops dashboard
(a known gap). Options, consent, ticket, claim, tamm, remeasure and next-day are walled with an explanation
(`ANONYMOUS_WALLED_ROUTES`; a test decides every screen of the app).

## What it keeps, and where

- The tab's note `{ session }` in `sessionStorage` under `mawsool.anonymous`: a random id, nothing else.
- The list of anonymous session ids this device has made a database for, in the device's own encrypted store (`KEYS.anonymousSessions`; ciphertext, local, never sent). An id is added before the session's database is first written and removed once that database is confirmed deleted (a deletion that is only queued behind a connection that ignores the request does not count). It lets a database be found and deleted where the browser cannot list its databases. When the last id goes the key goes too, so a device with no session left holds no list.
- The crisis block stays in the ordinary device store (safety beats wipe). It is marked `anonymous`, and so is the tab's crisis
  mark, so that a repair that runs after the session ended still never queues the event. It never waits on the anonymous
  database, so a store that refuses or hangs cannot stand between the person and the crisis screen.
- Check-ins (`screenings`; any other key is refused) are AES-GCM ciphertext under a non-extractable key, in the session's own
  IndexedDB database `mawsool-anon-<session id>`. The database's name is the only other plain trace of the session.

The plain-text items are named in Settings (`settings.exception`) and in `CLAUDE.md`: the crisis mark, the session note, and the
database name; none holds an answer, score or result. The Web Lock name `mawsool-anon:<id>` is held in memory only, while a page
lives, and is never stored. The session note, the database name and the crisis mark are the only plain stored traces.

## When the database is deleted

- Leaving the session (the person confirms; refused while a crisis is open).
- "Delete everything", in either mode: every session's database, live or not, and no request when anonymous. It never strands the
  phone's other data behind a database that will not delete: it reads the list of session ids (searching through the list alone
  when the browser's own listing fails), deletes every database it can, clears the device store regardless, writes the ids that
  were not deleted back to the list and reports "erased" with a note that those check-ins are removed at the next start of the app.
- The next start of the app in any tab, for every session whose Web Lock has been free for 2 s: a closed tab cannot wipe its
  own store, and a reload releases the lock only between two pages, which the 2 s grace waits out. A session that is live in
  another tab is never deleted by this.
- Without Web Locks (an old browser) every other session's database is deleted at a start by any tab, live or not. Without
  `indexedDB.databases()` the sessions listed in the device store (above) are the candidates, under the same lock rule.

An open page never outlives its database: when it is deleted from elsewhere the page drops its cached key and makes a new one
on its next write, and a value that cannot be decrypted deletes the database and starts fresh.

## Starting and leaving during a crisis

`/anonymous` is in `GUARDED_ROUTES`, so while a crisis is open it lands on the crisis screen, and `endAnonymousSession` refuses
while the tab's crisis mark is set. A crisis therefore stays the kind it opened as.
