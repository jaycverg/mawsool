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
packages/consent, fhir, summary   empty until their stories are built
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
| `pnpm db:up` / `db:down` / `db:migrate` / `db:seed` | Postgres lifecycle, migrations, deterministic seed |

`gate:phase2` installs Chromium on first use (only Chromium), runs on ports 250 above the dev ports (api 4250, export 3250, plus `PORT_OFFSET`), is bounded at 60 s a test and 9 minutes for the suite, and fails unless the report holds exactly the tests in `apps/person/e2e/acceptance.json`, in both languages. It rebuilds `apps/person/out` with its own API address baked in, so run `pnpm build` again before serving that folder elsewhere. It stays out of `verify` because it downloads a browser and takes minutes; run it before merging anything that touches the person app.

Tests that need a database use in-process PGlite with the real migrations, so `pnpm test` and the `gate:*` commands need no Docker. `pnpm verify` ends with `smoke:dev`, and `smoke:dev` and `db:*` do need Docker.

Second copy of the repo on one machine (for example a gate run from another worktree): set `PORT_OFFSET=100` in its `.env`. Every port moves together (api 4100, apps 3100-3102, Postgres 54429) and the Compose project becomes `mawsool-100`, so containers and volumes never collide.

## Guardrails (enforce in code and tests)

- No AI in scoring, triage or the crisis path. An LLM is used only in `packages/summary`, behind a flag, for the referral summary the person approves.
- The crisis path is deterministic and works offline. `packages/instruments` imports nothing but `@mawsool/types` and its own files; a test enforces it.
- Minimum data, granular consent, revocation deletes the shared copy. No employer or insurer data path.
- Equity data is opt-in and coarse: age band, gender, language, region. Aggregates under n = 10 are suppressed.
- Label every mock (directory, insurance, Malaffi export, TAMM link, messaging, crisis console).
- Arabic and English for every user-facing string. Message files hold all text; a lint rule fails on hard-coded JSX text.
- No phone number is collected before the reminders story. The device registers with a random id and secret; the server keeps only the secret's hash.
- Instrument wording comes from published sources only, never machine translation. `wordingStatus: 'verified'` means published validated wording: copied from an obtained source and backed by a cited validation study in `packages/instruments/SOURCES.md`. Everything else is `unverified` and shows a visible label.

## API conventions

- Every route declares `config.access` (`public | person | clinician | ops | admin | inbound`); startup throws otherwise. A clinician route under `/tickets` must also declare `facilityScoped: true` and use `facilityScopedTicket`.
- Time comes from `apps/api/src/clock.ts` through an injected `Clock`. Lint forbids `Date.now()` and `new Date()` elsewhere in `apps/api/src`.
- No column defaults to the database clock; the application writes every timestamp.
- Staff sign-in links are logged, never sent; one use, 15 minutes, only the hash stored. A clinician's link opens `<CLINICIAN_APP_URL>/en/sign-in/`, an ops or admin link opens `<OPS_APP_URL>/en/sign-in/`; the page spends the token only on a button press.

## Code and commit conventions

- A commit message is one line. No ticket numbers in code comments or product identifiers.
- Tests: a case per recovery branch; prove a guard by deleting it and watching its test fail; no disjunctive assertions.
- The person app stays wrappable as a native app: static export, no server components or actions, platform access only through `packages/ui` adapters.
- `.pnpmfile.cjs` drops Next's optional `@playwright/test` peer, so installing Playwright in one package does not make pnpm resolve a second copy of Next for it.
- The person app keeps everything on the device in an AES-GCM encrypted IndexedDB (`packages/ui/src/platform/encrypted-storage.ts`, key non-extractable). A trigger answer sets a persisted crisis block (`apps/person/lib/crisis.ts`); `CrisisGuard` in the `[locale]` layout sends `GUARDED_ROUTES` (`apps/person/lib/routes.ts`) to `/crisis` until it is resolved. Add a new matching or ticket screen to that list.
- The person app's service worker gets its precache list from `apps/person/scripts/build-precache.mjs` after `next build` (pages, built CSS and JS, fonts, manifest, icons, version from the build). To make a screen open offline, add it to `OFFLINE_SCREENS` there.
- `.local/` (plans, spec, design boards) is git-ignored and lives outside worktrees; read it by absolute path.
