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
- The crisis block stays in the ordinary device store (safety beats wipe). It is marked `anonymous`, and so is the tab's crisis
  mark, so that a repair that runs after the session ended still never queues the event. It never waits on the anonymous
  database, so a store that refuses or hangs cannot stand between the person and the crisis screen.
- Check-ins (`screenings`; any other key is refused) are AES-GCM ciphertext under a non-extractable key, in the session's own
  IndexedDB database `mawsool-anon-<session id>`. The database's name is the only other plain trace of the session.

The plain-text items are named in Settings (`settings.exception`) and in `CLAUDE.md`: the crisis mark, the session note, and the
database name; none holds an answer, score or result.

## When the database is deleted

- Leaving the session (the person confirms; refused while a crisis is open).
- "Delete everything", in either mode: every session's database, live or not, and no request when anonymous.
- The next start of the app in any tab, for every session whose Web Lock has been free for 2 s: a closed tab cannot wipe its
  own store, and a reload releases the lock only between two pages, which the 2 s grace waits out. A session that is live in
  another tab is never deleted by this.
- Without Web Locks (an old browser) every other session's database is deleted at a start. Without `indexedDB.databases()`
  only this tab's own database can be found, so a closed tab's database is not swept there.

An open page never outlives its database: when it is deleted from elsewhere the page drops its cached key and makes a new one
on its next write, and a value that cannot be decrypted deletes the database and starts fresh.

## Starting and leaving during a crisis

`/anonymous` is in `GUARDED_ROUTES`, so while a crisis is open it lands on the crisis screen, and `endAnonymousSession` refuses
while the tab's crisis mark is set. A crisis therefore stays the kind it opened as.
