# Mawsool MVP — Epics & Stories

2026-11-01

> **About this copy.** This is the product spec exactly as it was handed over, exported to `docs/` so it travels with the code. The diagrams the spec refers to (system architecture and ticket lifecycle) live in the design canvas and are not part of this export. Where the build settled a question the spec left open, the decision is recorded here and not in the body below, which is unchanged:
>
> - **Loop closed** means a ticket reached `seen` or later. Gate C stops at `seen`; `closed` follows a re-measure or the person ending the ticket. Rejected: the day-7 "Yes" firing `closed`; the sweep closing `seen` tickets later. Reason: it matches demo step 9 and keeps MW-307 reachable.
> - **The funnel's positive-screen stage** counts server-known screens only, and the tile says app-only screens are not counted. Rejected: an anonymous device count; a labelled seed figure. Reason: no new data leaves the device.
> - **Demo step 6 shows the AI draft**, with the assistant on in the video, in the hosted demo and in a live demo; `pnpm gate:c` runs with the assistant off and checks the template path. Rejected: an AI draft in Gate C. Reason: no key in CI, and the model writes different text each run. See [`running-the-demo.md`](running-the-demo.md#the-referral-summary-assistant-at-step-6).
> - **A `crisis_line` access value** is allowed in the MW-505 route test only for hand-offs the person consented to. Rejected: language and callback only; dropping MW-404 and MW-803. Reason: it keeps both stories with an explicit test. This belongs to the P1 stories, which are not built yet.
>
> The behaviour the build actually has, for example how metrics are suppressed, is in the root `CLAUDE.md`.

## Handover brief

Build a working hackathon MVP of **Mawsool**: a closed-loop referral "ticket" that turns a positive mental-health screen in Abu Dhabi into a time-bound hand-off to the least intensive appropriate care, and makes a missed hand-off visible. The product is the Ticket API; three web front-ends and a set of connectors sit around it.

**One-line pitch:** "The gap isn't that people aren't screened. It's that nobody owns them for the next 14 days."

**UI design:** [Mawsool UI Design canvas](https://claude.ai/artifact/2gKnLBBPJqyJTPt9M26M1J). It holds the hi-fi phone screens, clinician portal and ops dashboard, lo-fi wireframes, and three data-flow diagrams. Match screen copy and states to it.

### Guardrails (non-negotiable, enforce in code and tests)

- **No AI in scoring, triage or the crisis path.** Scores come from validated instruments; routing comes from a deterministic rules engine. An LLM is used in one place only: drafting the referral summary, which the person edits and approves before it leaves the device.
- **Crisis path is deterministic and offline-capable.** A PHQ-9 item 9 score above 0, or a positive C-SSRS screener answer, halts the flow and shows emergency numbers. The flow never continues to matching until the person dismisses the crisis screen.
- **Screen, not diagnosis.** Every result screen carries plain-language "what this means / what it does not mean" text.
- **Minimum data, granular consent.** Consent is per data element and per recipient, revocable, and revocation deletes the shared copy.
- **No employer or insurer data path.** No endpoint, role or export may return identifiable wellbeing data to an employer or insurer. Add a test that asserts this.
- **Equity data is opt-in and coarse.** Age band, gender, language, region only; aggregates suppressed below k = 10.
- **Label all mocks.** The service directory, insurance rules, Malaffi export and TAMM/Sahatna inbound link are mocked and must say so in the UI.
- **Bilingual from day one.** Arabic (RTL) and English for every user-facing string.

### Wrap-ready person app

`apps/person` must stay wrappable as a native app (MW-905):

- Builds as a static export (`output: 'export'`); no server components, server actions or API routes in this app. All server logic stays in `apps/api`.
- Storage, notifications and the phone dialler sit behind adapters in `packages/ui/platform` (web versions now, Capacitor versions later).
- A valid web manifest and service worker, so it installs as a PWA today.

### Non-goals for the MVP

Chatbot companion, passive sensing or wearables, peer community, native mobile apps, employer dashboards, real Malaffi posting, real insurance eligibility checks, real SMS/WhatsApp sending.

### Stack

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | One repo, shared types |
| Front-ends | Next.js (App Router) + Tailwind | `apps/person` (PWA), `apps/clinician`, `apps/ops` |
| i18n | next-intl | `ar` (RTL) and `en`; `dir` set on `<html>` |
| API | Node + Fastify + Zod | `apps/api`; OpenAPI generated from Zod schemas |
| Database | Postgres + Drizzle ORM | Docker Compose for local |
| Jobs | pg-boss | Deadline timers and day-7 nudges |
| Rules engine | Plain TypeScript module | `packages/rules`, pure functions, 100% unit-tested |
| Instruments | `packages/instruments` | PHQ-9, GAD-7, WHO-5, C-SSRS screener items + scoring |
| FHIR | `packages/fhir` | Builds an R4 Bundle; export only |
| LLM | Provider SDK behind `packages/summary` | Feature-flagged; falls back to a template |
| Tests | Vitest + Playwright | Playwright covers the demo script end to end |

### Repo layout

```
mawsool/
  apps/
    api/          Fastify Ticket API, jobs, seed script
    person/       PWA: screening, results, matching, consent, ticket, crisis
    clinician/    Incoming tickets, consented bundle, acknowledge/seen
    ops/          Funnel, timeliness, crisis, equity dashboard
  packages/
    instruments/  Items, scoring, reliable-change thresholds, explanations (ar/en)
    rules/        Stepped-care matcher, deadlines, insurance coverage table
    consent/      Consent model + redaction helpers
    fhir/         ServiceRequest + QuestionnaireResponse + Condition bundle
    summary/      LLM referral-summary draft + template fallback
    ui/           Shared components, tokens, RTL helpers
    types/        Shared Zod schemas and TS types
  infra/          docker-compose.yml, .env.example
  docs/           This spec exported as Markdown
```

## Architecture and data model

Everything flows through one service, the Ticket API. Front-ends and connectors only create tickets, read consented views of them, or move them to their next state. The diagrams for the system and the ticket lifecycle follow at the end of this section.

### Ticket states

| State | Entered when | Next states |
|---|---|---|
| `issued` | Person accepts a matched option and confirms consent | `acknowledged`, `overdue`, `declined`, `withdrawn` |
| `acknowledged` | Receiving clinic taps Acknowledge, or replies to the email/SMS link | `seen`, `overdue`, `withdrawn` |
| `seen` | Clinic marks Seen, or the person self-confirms on the day-7 check | `remeasured`, `closed` |
| `overdue` | Deadline passes without `seen` | `rerouted`, `seen` (late) |
| `rerouted` | Person picks a new option after an overdue or failed hand-off; spawns a child ticket | terminal (child ticket carries on) |
| `remeasured` | Person completes the follow-up PHQ-9/GAD-7 at 6–8 weeks | `closed` |
| `closed` | Loop complete, or person ends it | terminal |
| `declined` | Person declines care at any point | terminal |
| `withdrawn` | Person revokes consent; shared copies are deleted | terminal |

Crisis is not a ticket state. A crisis trigger creates a separate `CrisisEvent` and blocks matching until resolved, so a crisis can never sit in a queue.

### Stepped-care rules (proposed defaults, confirm with a clinical advisor)

| Screen result | Offered tier(s) | Hand-off target | Re-check |
|---|---|---|---|
| PHQ-9 item 9 > 0 or C-SSRS positive | Crisis path first: 800-SAKINA, 998/999 | Same-day human contact | After crisis resolved |
| PHQ-9 20–27 or GAD-7 15–21 | Specialist; GP or tele as bridge | Seen ≤ 14 days | 6 weeks |
| PHQ-9 15–19 | Specialist or trained GP | Seen ≤ 14 days | 6 weeks |
| PHQ-9 10–14 or GAD-7 10–14 | Trained GP at PHC, or tele (Pura/Sakina) | Seen ≤ 7 days | 6 weeks |
| PHQ-9 5–9 or GAD-7 5–9 | Guided self-help, community support | Started ≤ 14 days | 4 weeks |
| Below 5 | Self-help resources | None | 4 weeks (optional) |

Reliable change between two check-ins: PHQ-9 ≥ 6 points, GAD-7 ≥ 4 points (NHS Talking Therapies convention). Thresholds live in `packages/rules/config.ts`, not in code paths.

### Data model

| Entity | Key fields | Where it lives |
|---|---|---|
| `Person` | pseudonymous id, locale, optional demographic buckets (age band, gender, language, region), equity opt-in | Device first; server holds id + buckets only if opted in |
| `Screening` | instrument, item answers, total, severity band, item-9 flag, taken_at | Device; server copy only if consented to a recipient |
| `Ticket` | id, short code + QR, person id, tier, service id, state, deadline_at, source (app, PHC, TAMM, school), parent ticket id | Server |
| `TicketEvent` | ticket id, from → to state, actor (person, clinic, system), channel, at | Server, append-only |
| `Consent` | person id, recipient (service or clinician), element (scores, free text, conditions, demographics), granted_at, revoked_at | Server, append-only |
| `SharedBundle` | ticket id, recipient, FHIR R4 Bundle JSON, approved summary text, deleted_at | Server, encrypted at rest; hard-deleted on revoke |
| `Service` (mock) | name, tier, modality (in-person, tele), languages, clinician gender options, insurance classes, region, indicative wait days | Server, seeded |
| `CrisisEvent` | trigger (item 9, C-SSRS), shown_at, call tapped (which number), context shared y/n, human contact confirmed, follow-up at | Server, minimal fields |
| `AdverseEvent` | ticket or crisis id, type, severity, reported_by, at | Server |
| `StaffUser` | role (clinician, ops, admin), facility id | Server |

### Roles and what each may see

| Role | Sees | Never sees |
|---|---|---|
| Person | Everything about themselves | Other people |
| Clinician | Tickets addressed to their facility; only consented elements of the bundle | Unconsented elements, other facilities' tickets |
| Ops | Aggregates and pseudonymous ticket timings; buckets with n ≥ 10 | Names, free text, item answers |
| Employer, insurer | Nothing (no role exists) | Everything |

### System diagram

[diagram: system architecture · 4 surfaces, 1 API, 4 adapters]

The crisis call goes straight from the person's device to the phone line, so a network or API failure can never block it. Matching runs on the device too; the API only sees what the person consents to send.

### Ticket lifecycle

[diagram: ticket lifecycle · 9 states]

An overdue ticket can still be marked seen late. Rerouting never edits the old ticket; it closes it as rerouted and issues a linked child, so the dashboard keeps the whole journey.

## Epics and stories

**Parent epic MW — Mawsool MVP:** as a person in Abu Dhabi with a positive wellbeing screen, I get matched to the least intensive safe care and someone is accountable for my hand-off until I am seen, with my data under my control. The 10 epics below sum to 156 points, plus a 5-point P2 native-app story; the P0 stories (125 points) are the demo.

| Epic | Covers challenge requirement | Stories | P0 points |
|---|---|---|---|
| E0 Foundations | All | 5 | 16 |
| E1 Validated check-in | 1 Validated early identification | 6 | 14 |
| E2 Stepped matching | 2 Stepped, local navigation | 5 | 15 |
| E3 Ticket lifecycle | 2 hand-off, 6 follow-up | 7 | 20 |
| E4 Crisis escalation | 3 Human-led escalation | 6 | 9 |
| E5 Privacy and consent | 4 Privacy, consent, autonomy | 7 | 16 |
| E6 Clinician portal | 5 Coordinated care | 6 | 13 |
| E7 Outcomes dashboard | 6 Outcome and safety monitoring | 7 | 11 |
| E8 Connectors | 2, 5 (integration) | 4 | 3 |
| E9 Demo readiness | Pitch | 5 | 8 |

Priority: **P0** = needed for the demo, **P1** = build if time allows, **P2** = roadmap slide only. Sizes are story points (1, 2, 3, 5, 8).

### E0 Foundations

**MW-001 · Scaffold the monorepo** — P0 · 3 As the team, I want one repo with all apps and packages wired up so that everyone builds against shared types.

- `pnpm dev` starts `api`, `person`, `clinician`, `ops` and Postgres (Docker Compose).
- Lint, typecheck, Vitest and Playwright run in CI on every push.
- `.env.example` documents every variable; no secrets committed.

**MW-002 · Bilingual UI with RTL** — P0 · 3 As an Arabic or English speaker, I want the whole app in my language so that I understand every step.

- Language toggle on every screen, remembered on device.
- `ar` sets `dir="rtl"`; layout, icons with direction and progress bars mirror correctly.
- All strings live in message files; a lint rule fails on hard-coded JSX text.
- Playwright snapshots each key screen in both locales.

**MW-003 · Staff sign-in and roles** — P0 · 3 As a clinician or ops user, I want to sign in and see only what my role allows.

- Seeded demo users per role (clinician at two facilities, ops, admin); magic-link sign-in.
- Facility scoping middleware on every ticket route.
- Test: a clinician at facility A gets 404 for a ticket addressed to facility B.

**MW-004 · Pseudonymous person identity** — P0 · 2 As a person, I want to use the service without giving my name, so that stigma doesn't stop me.

- The device generates a random person id on first run; no name, email, Emirates ID or phone is required.
- A phone number is collected only if the person opts into reminders, and is stored separately from screening data.

**MW-005 · Seed data and simulator** — P0 · 5 As a presenter, I want realistic data so that the dashboard tells a story.

- Seeds at least 20 mock services across tiers, regions (Abu Dhabi city, Al Ain, Al Dhafra), languages and insurance classes, each flagged `sample: true`.
- Simulates 500 tickets over 90 days with plausible state timings.
- Plants one equity gap: loop-closed rate for Urdu-language tickets is about 20 points lower.
- Deterministic: the same seed produces the same data.

### E1 Validated check-in and change over time

**MW-101 · WHO-5 wellbeing opener** — P0 · 2 As a person, I want a short, low-stigma check-in so that starting feels easy.

- Five items, 0–5 scale; score = raw × 4 (0–100).
- A score ≤ 50 offers the PHQ-9 and GAD-7; a person can also choose them directly.

**MW-102 · PHQ-9 and GAD-7** — P0 · 3 As a person, I want validated questions so that my result means something.

- Uses published validated Arabic and English wording (no machine translation); sources recorded in `packages/instruments/SOURCES.md`.
- Correct totals and severity bands (PHQ-9: 0–4, 5–9, 10–14, 15–19, 20–27; GAD-7: 0–4, 5–9, 10–14, 15–21).
- PHQ-9 item 9 is evaluated the moment it is answered (see MW-401).
- 100% unit-test coverage on scoring.

**MW-103 · Result explainer** — P0 · 3 As a person, I want to know what my result means and doesn't mean, so I can decide what to do.

- Shows band, a plain-language meaning, and a "this is a screen, not a diagnosis" line.
- Never uses diagnostic labels ("you have depression").
- Copy per band is stored in message files and marked for clinical review.

**MW-104 · Trajectory and reliable change** — P0 · 3 As a person, I want to see how I'm changing over time, so I notice when things get worse.

- A line of totals per instrument across check-ins.
- Flags reliable deterioration (PHQ-9 up ≥ 6, GAD-7 up ≥ 4) and reliable improvement, with explanatory text.
- Reliable deterioration re-runs matching and offers the next tier.

**MW-105 · Local-first storage** — P0 · 3 As a person, I want my answers kept on my phone unless I choose to share.

- Screenings stored in encrypted IndexedDB; the check-in and result work offline.
- "Download my data" (copyable JSON) and "Delete everything" are in Settings.

**MW-106 · Check-in reminders** — P1 · 2 As a person, I want an optional reminder to re-check.

- Off by default; every 2 or 4 weeks; reminder text contains no clinical content.

### E2 Stepped matching and navigation

**MW-201 · Rules engine** — P0 · 5 As a person, I want options that fit my need, offered least-intensive-first.

- Pure function `match(screening, prefs, insurance, region, services) → RankedOption[]`, each with `reasons[]` and `eligibility[]`.
- Runs on the device, so preferences and insurance class never leave it during matching.
- Implements the stepped-care table in the Architecture section; crisis always takes precedence.
- Table-driven unit tests cover every band × insurance class.

**MW-202 · Preferences** — P0 · 2 As a person, I want to say what matters to me.

- Language, clinician gender, in-person or tele, region, time of day; all optional.

**MW-203 · Insurance coverage panel** — P0 · 3 As an expatriate, I want to know what my plan likely pays for before I book.

- Choices: Thiqa, Daman Basic, Daman Enhanced, other private, not sure.
- Each option shows indicative coverage: covered, co-pay, pay and claim, or unknown.
- Always labelled "Indicative only — verify with your insurer"; data is a sample table in `packages/rules`.

**MW-204 · Option cards** — P0 · 3 As a person, I want to see why each option fits and what I need to use it.

- Shows 1–3 cards: tier, service name, modality, languages, indicative wait, coverage, "why this fits" reasons, eligibility.
- "Show other options" lists the remaining tiers; the person can choose a more or less intensive one.

**MW-205 · Service directory (mock)** — P0 · 2

- `GET /services` with filters; every record and card shows a "Sample data" badge.

### E3 Ticket lifecycle (closed loop)

**MW-301 · Issue a ticket** — P0 · 5 As a person, I want a ticket that proves I've been referred and tells me what happens next.

- `POST /tickets` requires a consent record; returns id, 6-character short code, QR payload and `deadline_at` from the rules.
- Writes an `issued` `TicketEvent`; idempotent on client request id.

**MW-302 · Person ticket view** — P0 · 3

- Status timeline, deadline countdown, clinic contact, what to bring, and Decline and Change option buttons.
- The QR and short code can be shown at reception.

**MW-303 · Enforced state machine** — P0 · 3

- Only the transitions in the Ticket states table are allowed; anything else returns 409.
- Events are append-only; current state is derived from them; property-based tests on transitions.

**MW-304 · Deadlines and overdue** — P0 · 3

- A pg-boss job moves tickets past `deadline_at` without `seen` to `overdue`.
- Overdue tickets appear in the ops view and prompt the person to reroute.

**MW-305 · Day-7 "did you get seen?" check** — P0 · 3 As a person, I want a nudge that helps if my referral stalled.

- On day 7 (or at the deadline if sooner) the person app asks: Yes / Not yet / I don't want this any more.
- Yes → `seen` with `self_confirmed: true`. Not yet → reason (couldn't book, cost, wait too long, other) and reroute options. No → `declined`.

**MW-306 · Reroute** — P0 · 3

- Creates a child ticket linked by `parent_ticket_id`; the parent moves to `rerouted` with the reason.
- The dashboard counts the chain as one person journey.

**MW-307 · Re-measure** — P1 · 3

- 6 weeks after `seen`, prompts a repeat PHQ-9/GAD-7; with consent, sends the total to the ticket; moves to `remeasured`.

## Build order and definition of done

Build in five phases, safety first: the pure packages and the crisis path are tested before any matching UI exists, and consent is enforced before any clinician sees data.

1. **Core packages.** E0, plus `packages/instruments` and `packages/rules` as pure, fully tested functions (MW-102, MW-201).
2. **Person flow.** E1, E2 and E4. Build the crisis trigger and screen (MW-401, MW-402) before the option cards.
3. **Closed loop.** E3 and E5: API, state machine, consent ledger, revoke and delete, deadline jobs.
4. **Receiving side.** E6 and MW-801: clinician queue, consented detail, FHIR export, inbound invite.
5. **Dashboard and demo.** E7 and E9: metrics on seeded data, demo clock, end-to-end test.

**Gates.** Gate A (after phase 1): crisis-trigger tests pass with the network off. Gate B (after phase 3): the consent and no-employer tests pass (MW-502, MW-505). Gate C (done): the demo E2E test passes in Arabic and English.

### Definition of done (every story)

- [ ] Acceptance criteria met and covered by tests (unit for packages, Playwright for flows)
- [ ] Every new string present in `ar` and `en`; screen checked in RTL
- [ ] No new route exposes wellbeing data beyond the Roles table; MW-505 still green
- [ ] Mocked data visibly labelled
- [ ] No AI call outside `packages/summary`; none in the crisis or scoring code paths
- [ ] Lint, typecheck and CI green; OpenAPI updated for API changes

## Demo script and seed data

The demo runs six minutes on seeded data with the demo clock; MW-903 automates exactly these steps.

**Persona 1 — Noura, 27, private-sector employee, Daman Basic, Arabic.**

1. A mock TAMM result page shows a positive screen and a "Continue with Mawsool" link (MW-801). Noura claims the invite.
2. WHO-5 = 44, so she is offered GAD-7 and PHQ-9: GAD-7 = 9 (mild), PHQ-9 = 7 (mild). The result explainer says what this means and does not mean.
3. She picks guided self-help. The demo clock moves +3 weeks.
4. Re-check: GAD-7 = 14 (moderate), up 5 points, which is reliable deterioration. Matching now offers a trained GP within 7 days, a Pura/Sakina tele session and self-help.
5. Insurance panel: "Daman Basic — PHC visit indicative: covered; private therapy indicative: pay and claim."
6. Consent screen: she shares scores and trajectory, not her free-text note. The AI drafts a summary; she edits one line and approves it.
7. Ticket issued: short code, QR code, deadline in 7 days.
8. Switch to the clinician portal: the ticket is in the queue. The GP opens it, sees "Free-text note: not shared by the person", and taps Acknowledge.
9. Demo clock +7 days. Noura's day-7 check: "Did you get seen?" Yes. The ticket moves to seen and the loop closes.

**Persona 2 — Rashid, 19, student, English.**

10. He answers PHQ-9 item 9 with "several days". The questionnaire stops and the crisis screen appears with 800-SAKINA, 999 and 998. He taps Call; the event is logged as contact confirmed.

**Dashboard.**

11. Funnel from positive screen to seen; % seen within target by tier; crisis completion.
12. Equity view flags Urdu-language tickets with a loop-closed rate about 20 points below the overall rate. The pitch line: "This is the gap nobody could see before."

**Seed data contents:** 20+ mock services, 2 facilities with clinician users, 1 ops user, 500 simulated tickets over 90 days, the planted Urdu gap, and the two personas.

## Open questions and facts to verify

None of these block the build; each one is a config value or a line of copy. Recheck all of them before the pitch.

- [ ] Call 800-SAKINA (800 725462) to confirm it is live, 24/7 and bilingual; it could not be independently confirmed live as of August 2026. Keep 999 and 998 on screen regardless.
- [ ] Get clinical sign-off on the stepped-care thresholds and hand-off windows (7 and 14 days).
- [ ] Confirm the source and licence for the validated Arabic PHQ-9, GAD-7, WHO-5 and C-SSRS screener wording.
- [ ] Check indicative mental-health coverage for Thiqa, Daman Basic and Daman Enhanced against current policy wording.
- [ ] Confirm Malaffi's onboarding route for a third-party referral source, and keep calling the export "Malaffi-ready" until then.
- [ ] Confirm the hosting region and LLM provider meet UAE health-data localisation and DoH AI policy before enabling MW-504 outside the demo.
- [ ] Choose nationality buckets for the equity view (for example Emirati, Arab expatriate, South Asian, other) with the programme team.
- [ ] Find a public figure for the 2024–2025 screening-volume increase and the screen-to-specialist conversion rate; none was found, so do not quote a number.

### Sources

- [DoH — 800-SAKINA hotline launch](https://www.doh.gov.ae/en/news/doh-activates-247-mental-health-support-hotline-800-sakina-(725462))
- [DoH — Abu Dhabi mental health access update](https://www.doh.gov.ae/en/news/from-specialised-care-to-community-centered-support-ad-redefines-access-to-mh-services)
- [DoH — Malaffi health information exchange](https://www.doh.gov.ae/en/resources/HIE)
- [Al Tamimi — DoH policy on AI in healthcare](https://tamimi.com/news/new-policy-on-artificial-intelligence-in-healthcare-issued-by-the-department-of-health-abu-dhabi)
- [trade.gov — UAE limits on cross-border health data](https://www.trade.gov/market-intelligence/united-arab-emirates-regulations-limit-cross-border-health-data-flows)
- [Population Medicine — depression and anxiety among adults in Abu Dhabi](https://www.populationmedicine.eu/Depression-and-Anxiety-among-Adults-in-Abu-Dhabi-A-population-based-study,229332,0,2.html)

### E4 Crisis escalation (human-led)

**MW-401 · Crisis trigger** — P0 · 3 As a person at risk, I want help shown immediately, not after I finish a questionnaire.

- Fires the moment PHQ-9 item 9 is answered > 0, or any C-SSRS screener item is answered yes.
- Evaluated on the device by `packages/instruments`; needs no network and no AI.
- Interrupts the questionnaire and blocks matching until the crisis screen is resolved.
- Unit tests cover every trigger answer; Playwright tests run with the network off.

**MW-402 · Crisis screen** — P0 · 3

- Full-screen, calm design, in the person's language.
- Shows 800-SAKINA (800 725462, 24/7, Arabic and English), 999 (police) and 998 (ambulance) as large tap-to-call buttons, with each number also shown as text.
- Choices: "Call now", "I'm with someone safe", "I'm safe right now — continue". No auto-dismiss; no swipe-away.
- Numbers come from one config file with a `last_verified` date shown in the admin view.

**MW-403 · Crisis event logging** — P0 · 2

- Logs a `CrisisEvent`: trigger, shown_at, which number was tapped, context shared, human contact confirmed (self-report or mock line confirmation), resolved_at.
- Queues offline and sends when the device reconnects; no item answers are logged.

**MW-404 · Optional context hand-off to the line** — P1 · 3

- With one explicit consent, sends a short template (language, scores, "item 9 positive", callback number if given) to a mock crisis-line console.
- The console can mark "contact made", which completes the event.

**MW-405 · Next-day crisis follow-up** — P1 · 2

- A next-day check asks how the person is and offers a GP or specialist ticket.

**MW-406 · Safe-messaging copy review** — P0 · 1

- Crisis copy is checked against safe-messaging guidance: no method detail, hopeful language, help-seeking framed as strength. Checklist stored in `docs/`.

### E5 Privacy, consent and autonomy

**MW-501 · Granular consent screen** — P0 · 5 As a person, I want to choose exactly what each recipient sees.

- A matrix of elements (scores, trajectory, free-text note, self-reported conditions, preferences) × the chosen recipient.
- The only required element is the ticket itself (code, tier, deadline, language); everything else defaults to off.
- Plain-language preview: "Dr X's clinic will see: …".

**MW-502 · Consent ledger API** — P0 · 3

- `POST /consents` and `DELETE /consents/:id` (revoke); the ledger is append-only.
- Every bundle read checks live consent; revoked consent returns 410.

**MW-503 · Revoke and delete** — P0 · 3

- Revoking hard-deletes the matching `SharedBundle` content and moves the ticket to `withdrawn` if the ticket consent is revoked.
- The clinician view shows "Withdrawn by the person" and no data.

**MW-504 · AI-drafted referral summary with approval** — P1 · 3

- Off unless the person ticks "Use AI to help write my note"; otherwise a fill-in template is used.
- The prompt forbids diagnosis, advice and risk scoring; output is limited to 120 words.
- The person edits and approves; only approved text is shared. Approved and draft versions are both logged.

**MW-505 · No employer or insurer access (test)** — P0 · 2

- An automated test enumerates every API route and asserts that no role other than person, clinician (scoped) or ops (aggregate) can return wellbeing data.
- Aggregates with n < 10 return `suppressed`.

**MW-506 · Encryption and access audit** — P0 · 3

- `SharedBundle` and free text are encrypted at the column level.
- Every bundle read writes an audit row (who, when, ticket); the person can see the reads of their own ticket.

**MW-507 · Anonymous mode** — P1 · 2

- Check-in, results and crisis guidance work with zero server calls; the person is told what an anonymous session cannot do (no ticket).

### E6 Clinician portal and coordinated care

**MW-601 · Incoming queue** — P0 · 3 As a GP, I want to see who is coming and by when.

- Tickets for my facility sorted by deadline; filter by state and tier; overdue rows highlighted; nothing shown beyond the ticket fields until opened.

**MW-602 · Ticket detail with the consented bundle** — P0 · 5

- Shows the approved summary, scores and trajectory, preferences and self-reported conditions, but only consented elements.
- Unconsented elements appear as "Not shared by the person".
- Every open is audited (MW-506).

**MW-603 · Acknowledge, Seen, Unable to see** — P0 · 2

- One-tap actions that move the ticket state; "Unable to see" requires a reason and prompts the person to reroute.

**MW-604 · Physical and mental context panel** — P1 · 3

- Shows the PHQ-9/GAD-7 trajectory beside self-reported conditions (diabetes, hypertension, chronic pain and others) and sample labs such as HbA1c, labelled "Sample — would come from Malaffi".

**MW-605 · FHIR R4 export** — P0 · 3

- Builds a Bundle of ServiceRequest, QuestionnaireResponse and Condition from consented elements only.
- Validates against the R4 schema in tests; copy-to-clipboard; labelled "Malaffi-ready export — not sent".

**MW-606 · No-login clinic channel** — P1 · 2

- A clinic without portal access gets a signed one-time link (logged, not sent) to Acknowledge or mark Seen.

### E7 Outcomes, safety and equity dashboard

**MW-701 · Referral funnel** — P0 · 3 As a programme lead, I want to see where people drop off after a positive screen.

- Stages: positive screen → ticket issued → acknowledged → seen → re-measured, with counts and the share that carries on between each.
- Filter by period, source (app, PHC, TAMM, school) and tier.

**MW-702 · Timeliness** — P0 · 3

- % seen within the target window, by tier; median and 90th-percentile time to seen; indicative wait by service.
- Overdue tickets list (pseudonymous ids only).

**MW-703 · Crisis-response completion** — P0 · 2

- Crisis screens shown, % with a number tapped, % with human contact confirmed, median time from trigger to contact.

**MW-704 · Symptom and functioning change** — P1 · 3

- Among re-measured tickets: mean change in PHQ-9 and GAD-7, % reliable improvement, % reliable deterioration.

**MW-705 · Equity view** — P0 · 3

- Loop-closed rate and time to seen by age band, gender, nationality group, language and region (opt-in buckets).
- Cells with n < 10 show "suppressed"; a gap of 10 points or more from the overall rate is flagged.

**MW-706 · Adverse events log** — P1 · 2

- Record and list adverse events (missed crisis follow-up, wrong routing, data incident) with severity and status.

**MW-707 · Metric definitions** — P1 · 1

- Each tile has an info panel with its exact definition, numerator and denominator.

### E8 Connectors

**MW-801 · Inbound screen from an existing front door** — P0 · 3 As TAMM, a PHC or a school programme, I want to hand a positive screen to Mawsool instead of leaving the person with advice only.

- `POST /inbound/screens`, signed with a per-source HMAC key; creates an invite, never a ticket.
- The person claims the invite by link or code and then consents; nothing is shared until they do.
- A mock "TAMM result page" demonstrates the deep link, labelled as a mock.

**MW-802 · Messaging adapter** — P1 · 2

- `Notifier` interface with console and log drivers; Arabic and English templates; messages carry no clinical content.

**MW-803 · Crisis-line console (mock)** — P1 · 2

- A simple page that receives MW-404 hand-offs and lets the operator mark contact made.

**MW-804 · OpenAPI documentation** — P1 · 1

- `/docs` serves OpenAPI generated from the Zod schemas.

### E9 Demo readiness

**MW-901 · Personas and one-click reset** — P0 · 2

- Admin button resets the database to the seed and loads the Noura and Rashid personas.

**MW-902 · Demo clock** — P0 · 2

- Behind a `DEMO_MODE` flag, an admin control advances time (+3 weeks, +7 days, +6 weeks) to fire deadlines, the day-7 check and re-measure.

**MW-903 · End-to-end demo test** — P0 · 3

- A Playwright test runs the whole demo script in both languages and fails on any console error.

**MW-904 · Mock-label audit** — P0 · 1

- Every mocked surface (directory, insurance, Malaffi, TAMM, messaging, crisis console) shows a visible "Sample" or "Mock" label; checked in the E2E test.

**MW-905 · Native app wrapper (Capacitor)** — P2 · 5 As a person, I want Mawsool from the App Store or Play Store, with reliable reminders.

- Wrap `apps/person` with Capacitor for iOS and Android; push replaces local reminders for the day-7 check.
- Secure storage moves from IndexedDB to Keychain/Keystore via the storage adapter; optional biometric lock.
- Android can ship earlier as a Trusted Web Activity with no code change.
- Store submissions include a privacy policy, accurate privacy labels and visible crisis resources.

### Key API endpoints

| Method + path | Caller | Purpose |
|---|---|---|
| `GET /services` | Person app | Mock directory for on-device matching |
| `POST /consents` / `DELETE /consents/:id` | Person app | Grant and revoke per element |
| `POST /tickets` | Person app | Issue a ticket (consent id required) |
| `GET /tickets/:id` | Person, clinician | Ticket + consented view only |
| `POST /tickets/:id/events` | Person, clinician, system | Move state (acknowledge, seen, unable, decline, self-confirm) |
| `POST /tickets/:id/reroute` | Person app | Child ticket from a stalled one |
| `GET /tickets/:id/fhir` | Clinician | R4 Bundle of consented elements |
| `POST /crisis-events` | Person app | Log a crisis screen and outcome |
| `POST /inbound/screens` | TAMM, PHC, school (mock) | Signed invite from an existing front door |
| `GET /metrics/*` | Ops | Funnel, timeliness, crisis, outcomes, equity (k ≥ 10) |
