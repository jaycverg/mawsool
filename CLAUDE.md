# Mawsool

Closed-loop referral ticket for mental-health care in Abu Dhabi: a positive screen becomes a time-bound hand-off, and a missed hand-off is visible. A hackathon MVP. The Ticket API (`apps/api`) is the product; three web apps and connectors sit around it.

## Layout

```
apps/api         Fastify + Zod + Drizzle ticket API, staff sign-in, seed
apps/person      PWA, static export (output: 'export'): screening, results, matching, consent, ticket, crisis
apps/clinician   incoming tickets, consented bundle
apps/ops         funnel, timeliness, crisis, equity dashboard
packages/types        Zod schemas and TS types for every entity and contract
packages/instruments  WHO-5, PHQ-9, GAD-7, C-SSRS items, scoring, evaluateCrisis(); SOURCES.md for the wording
packages/rules        match(), deadlines, config.ts (thresholds, windows, crisis numbers, sample insurance table)
packages/ui           tokens, fonts, RTL helpers, platform adapters (storage, notifications, dialler), shared components
packages/consent      the consent element list and redact(): keeps only consented elements, run on the phone before send and again on the server
packages/summary      the only code that may call an LLM: referral-summary prompt over consented elements, template fallback, the Anthropic provider
packages/fhir         empty until its story is built
infra/           docker-compose.yml        docs/     checklists and the exported spec
```

Workspace packages export TypeScript source (`exports` points at `src/index.ts`); apps transpile them. The API bundles them with tsup.

## Commands

Node comes from `.nvmrc` (`nvm use`); pnpm is pinned by `packageManager`. Copy `.env.example` to `.env`. Docker must be running (`orb start`).

| Command | What it does |
| --- | --- |
| `pnpm dev` | Postgres (Compose), migrations, then API :4000, person :3000, clinician :3001, ops :3002 |
| `pnpm verify` | script tests, lint, typecheck, Vitest with coverage thresholds, builds, then `smoke:dev`. CI runs exactly this, so Docker must be running |
| `pnpm smoke:dev` | starts `pnpm dev`, waits for all four apps to answer 200, stops everything |
| `pnpm gate:a` | crisis triggers fire with every network entry point stubbed to throw |
| `pnpm gate:facility-scope` | a clinician at one facility gets 404 on another facility's ticket |
| `pnpm gate:seed` | seed content, determinism and the planted Urdu gap |
| `pnpm gate:phase2` | Phase 2 exit acceptance: builds the person export, serves it with the real API on in-process Postgres, and runs the Playwright suite in `apps/person/e2e` in `ar` and `en` with a real service worker. No Docker. Not part of `verify` |
| `pnpm gate:b` | Phase 3 exit acceptance, server side (the spec's Gate B): runs the whole Vitest suite of every project named in `scripts/gate-b.json`, on PGlite with the real migrations, and fails unless every sentence of the exit acceptance has its named tests present, unambiguous and passed, and nothing ran skipped or empty. No Docker, no browser. Browser sentences are listed apart as delegated to `gate:phase3` and are not run here |
| `pnpm gate:postgres` | What PGlite cannot show, on the real Compose Postgres: eight connections sweeping at once leave exactly one `overdue` per ticket, pg-boss starts, the sweep's schedule exists and one fire of the queue runs the sweep. Works in a throwaway database it drops. Needs Docker and **fails** when Docker is unavailable, never skips. Under a minute; kept out of `verify` because it only matters when the sweep or the queue changes. It leaves Compose Postgres running (`pnpm db:down`) |
| `pnpm gate:phase3` | Phase 3 exit acceptance, browser side: the consent, ticket, revoke, day-7, reroute and Delete everything flows in `ar` and `en` against the real API, registry `apps/person/e2e/acceptance-phase3.json`. Same shape as `gate:phase2`, ports 300 above the dev ports. Not part of `verify` |
| `pnpm db:up` / `db:down` / `db:migrate` / `db:seed` | Postgres lifecycle, migrations, deterministic seed |

Both browser gates share `scripts/e2e-gate.mjs` and run one spec each (`exit-acceptance.spec.ts`, `phase3-acceptance.spec.ts`). `E2E_GREP=<text>` runs only the tests whose title contains the text, to work on one; a subset run prints that it is not an acceptance result and exits non-zero. The end-to-end API also opens a read-only inspect listener (`apps/api/src/cli/serve-e2e.ts`) so a test can read what the API stored: raw bundle ciphertext, events, consents. It is a harness, not part of the product API.

`gate:phase2` installs Chromium on first use (only Chromium), runs on ports 250 above the dev ports (api 4250, export 3250, plus `PORT_OFFSET`), is bounded at 60 s a test and 9 minutes for the suite, and fails unless the report holds exactly the tests in `apps/person/e2e/acceptance.json`, in both languages. It rebuilds `apps/person/out` with its own API address baked in, so run `pnpm build` again before serving that folder elsewhere. Its registry also holds pixel snapshots of seven screens at 390×844 in both languages; the committed baselines (`apps/person/e2e/exit-acceptance.spec.ts-snapshots/`) are for Chromium on macOS (`-chromium-darwin.png`), a run on another platform fails for want of its own baselines, and `E2E_UPDATE_SNAPSHOTS=1 pnpm gate:phase2` rewrites them on purpose. It stays out of `verify` because it downloads a browser and takes minutes; run it before merging anything that touches the person app.

Tests that need a database use in-process PGlite with the real migrations, so `pnpm test` and the `gate:*` commands need no Docker. `pnpm verify` ends with `smoke:dev`, and `smoke:dev` and `db:*` do need Docker.

The API needs `BUNDLE_ENCRYPTION_KEY` (32 random bytes as base64) and refuses to start without one; `.env.example` carries a throwaway key for local development only. `SUMMARY_LLM_ENABLED` is off by default and, when on, also needs `ANTHROPIC_API_KEY`; no key is ever committed.

Second copy of the repo on one machine (for example a gate run from another worktree): set `PORT_OFFSET=100` in its `.env`. Every port moves together (api 4100, apps 3100-3102, Postgres 54429) and the Compose project becomes `mawsool-100`, so containers and volumes never collide.

## Guardrails (enforce in code and tests)

- No AI in scoring, triage or the crisis path. An LLM is used only in `packages/summary`, behind a flag, for the referral summary the person approves. A lint rule (`no-restricted-imports` in `eslint.config.mjs`) and a manifest check fail when anything else imports an LLM SDK; `packages/summary/test/boundary.test.ts` proves it with cases that must fail.
- The crisis path is deterministic and works offline. `packages/instruments` imports nothing but `@mawsool/types` and its own files; a test enforces it.
- Minimum data, granular consent, revocation deletes the shared copy. No employer or insurer data path: `apps/api/test/access.test.ts` walks the live route registry, fails on a route nobody reviewed, and refuses every wrong principal on every person and clinician route.
- Equity data is opt-in and coarse: age band, gender, language, region. Aggregates under n = 10 are suppressed.
- Label every mock (directory, insurance, Malaffi export, TAMM link, messaging, crisis console).
- Arabic and English for every user-facing string. Message files hold all text; a lint rule fails on hard-coded JSX text.
- No phone number is collected before the reminders story. The device registers with a random id and secret; the server keeps only the secret's hash.
- Instrument wording comes from published sources only, never machine translation. `wordingStatus: 'verified'` means published validated wording: copied from an obtained source and backed by a cited validation study in `packages/instruments/SOURCES.md`. Everything else is `unverified` and shows a visible label.

## API conventions

- Every route declares `config.access` (`public | person | clinician | ops | admin | inbound`); startup throws otherwise. A clinician route under `/tickets` must also declare `facilityScoped: true` and use `facilityScopedTicket`.
- Time comes from `apps/api/src/clock.ts` through an injected `Clock`. Lint forbids `Date.now()` and `new Date()` elsewhere in `apps/api/src`.
- No column defaults to the database clock; the application writes every timestamp.
- Person routes read only the caller's own rows: a ticket that is not theirs is a 404, the same as one that does not exist (`ownedTicket`). Person ticket reads live under `/me/...`; `GET /tickets/:id` and the clinic's event and bundle routes are staff and facility-scoped. Staff routes under `/tickets` must declare `facilityScoped`.
- A ticket's state is derived from its `TicketEvent` rows; `tickets.state` is a cache written in the same transaction as the event that claims the next `(ticket_id, seq)`. The unique constraint arbitrates every race: a lost race is a 409 for a request and a no-op for the sweep. The transition table, with who may fire each move, is `src/tickets/transitions.ts`; an illegal move is 409, a move the actor may not make is 403. "Unable to see" is a same-state event with a reason, clinic only.
- `SharedBundle`, its approved summary and the logged summaries are AES-256-GCM ciphertext (`src/crypto.ts`), bound to their row. Every bundle read checks live consent, redacts again to the consented elements, and writes a `bundle_reads` row. A live `ticket` consent decides a person's withdrawal before the state machine: it ends the share from any state, and from a terminal state changes no state. Revoking one element rewrites the bundle without it and, if a summary exists, removes the approved summary and the ticket's logged drafts too (the response says `summaryRemoved`); revoking `ticket` empties the bundle, deletes the person's logged drafts that no ticket claimed, and withdraws a live ticket. After it, the staff ticket read and the bundle read both answer 410 (another facility still 404). `sweep` also deletes unclaimed drafts older than 24 hours. Logged summaries are bound to `person:request:kind`. `ticket_events.reason` holds a code from a fixed list (reroute, unable to see, consent revoked), never free text; "unable to see" is its own request (`{unable: true, reason}`), and a same-state move is 409. `DELETE /me/data` does that for everything the person holds.
- `sweep(db, clock)` (`src/sweep.ts`) appends `overdue` to tickets past their deadline; pg-boss runs it every minute (`src/jobs.ts`). It is idempotent and safe to run concurrently.
- `/docs` serves the OpenAPI document, generated from the routes' Zod schemas.
- Staff sign-in links are logged, never sent; one use, 15 minutes, only the hash stored. A clinician's link opens `<CLINICIAN_APP_URL>/en/sign-in/`, an ops or admin link opens `<OPS_APP_URL>/en/sign-in/`; the page spends the token only on a button press.

## Code and commit conventions

- A commit message is one line. No ticket numbers in code comments or product identifiers.
- Tests: a case per recovery branch; prove a guard by deleting it and watching its test fail; no disjunctive assertions.
- The person app stays wrappable as a native app: static export, no server components or actions, platform access only through `packages/ui` adapters.
- `.pnpmfile.cjs` drops Next's optional `@playwright/test` peer, so installing Playwright in one package does not make pnpm resolve a second copy of Next for it.
- The person app keeps everything on the device in an AES-GCM encrypted IndexedDB (`packages/ui/src/platform/encrypted-storage.ts`, key non-extractable), with one deliberate exception: while a crisis is open the tab's `sessionStorage` holds `{trigger, eventId, shownAt}` in plain text (`packages/ui/src/platform/tab-mark.ts`), so a store that refuses or hangs cannot lose the block. It holds no answer, score or person id, and goes when the crisis is resolved, on Delete everything, or when the tab closes. Settings says so in both languages (`settings.exception`); `phase3-acceptance.spec.ts` asserts the note's keys. A trigger answer sets a persisted crisis block (`apps/person/lib/crisis.ts`); `CrisisGuard` in the `[locale]` layout sends `GUARDED_ROUTES` (`apps/person/lib/routes.ts`) to `/crisis` until it is resolved. Add a new matching or ticket screen to that list.
- The person app's service worker gets its precache list from `apps/person/scripts/build-precache.mjs` after `next build` (pages, built CSS and JS, fonts, manifest, icons, version from the build). To make a screen open offline, add it to `OFFLINE_SCREENS` there.
- Consent is per element and defaults off, except the required `ticket` element. What the person types for the clinic stays on the phone until they send. A pick that is waiting on consent is kept apart from the current choice (`choice:pending`), and its request id is made once, so a retried send is the same request. "Delete everything" (`apps/person/lib/erase.ts`) sends an unsent crisis record first, then asks the server to remove everything, and stops with nothing deleted if the server holds data and cannot be reached; with nothing ever shared it wipes offline. Erasure wins over an unsent crisis record when it cannot be sent, and the person is told.
- `.local/` (plans, spec, design boards) is git-ignored and lives outside worktrees; read it by absolute path.
