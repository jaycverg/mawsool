# Mawsool

**A closed-loop referral ticket for mental-health care in Abu Dhabi.** A positive wellbeing screen becomes a
time-bound hand-off to the least intensive suitable care, someone owns it until the person is seen, and a missed
hand-off shows up on a dashboard instead of disappearing.

> The gap isn't that people aren't screened. It's that nobody owns them for the next 14 days.

This is a hackathon prototype. It runs end to end on sample data, in Arabic and English, and is **not ready for use with
real people**: see [Limitations](docs/limitations.md). A copy runs at [mawsool.thevergara.dev](https://mawsool.thevergara.dev),
with one-click demo sign-in for the staff apps ([the hosted demo](docs/running-the-demo.md#the-hosted-demo)).

## Submission documents

| Document                                                     | What it covers                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [Demo video](https://youtu.be/QZM8wlpWVwY) | A 3-minute narrated walkthrough of the working prototype, with chapters, including the AI-drafted referral note |
| [Presentation deck](https://claude.ai/artifact/KGqvadTVZmvEAYxm1veNDB) | The 15-slide pitch: problem, idea, the three apps, safety, privacy, AI use, architecture, checks, limits |
| [Technical documentation](docs/technical-documentation.md)   | Architecture, flows, ticket lifecycle, privacy, AI use, security, API, testing, how to run it |
| [Assumptions](docs/assumptions.md)                           | What the prototype takes for granted: clinical, local services, privacy, technology, demo |
| [Limitations](docs/limitations.md)                           | What stands between it and real use, what is mocked, and the known gaps            |
| [Running the demo](docs/running-the-demo.md)                 | The 12-step demo with its two personas, and the demo clock                         |
| [Product spec](docs/product-spec.md)                         | The epics, stories and demo script the prototype was built from                    |

## What a person, a clinic and a programme lead get

- **A person** answers a short check-in (WHO-5, then PHQ-9 and GAD-7), sees a plain result that says what it does and
  does not mean, and is offered care options that fit their score, preferences, region and insurance. They choose what
  the clinic may see, item by item, and get a ticket with a code, a QR and a deadline. On day 7 the app asks whether
  they were seen and offers another option if not. Their answers stay on the phone, encrypted, unless they choose to
  share. No name or account is needed.
- **Someone at risk** who answers the self-harm question on the PHQ-9 sees a crisis screen at once, with 800-SAKINA, 999
  and 998, even offline once the app has been opened online once. Matching stays blocked until they say they are safe.
- **A clinic** sees a queue of the tickets addressed to it, ordered by deadline, reads only what the person agreed to
  share, marks the ticket acknowledged or seen, and can export a FHIR R4 referral.
- **A programme lead** sees where people drop off after a positive screen, how many are seen on time, how crises end,
  and which groups are being left behind, with every group under 10 people hidden.

![A person's journey in three lanes: on the phone, check-in, result, care options, consent and send; the Ticket API issues the ticket; the clinic acknowledges and marks it seen; the phone asks on day 7 whether the person was seen, and six weeks later offers a repeat check, after which the ticket closes. A crisis answer opens the crisis screen at once, on the phone](docs/images/person-journey.svg)

Source: drawn by hand from the code; the architecture, the ticket's states and the other flows are drawn in the
[technical documentation](docs/technical-documentation.md).

**What this tells us**
- Scoring and matching happen on the phone, and the clinic sees only the items the person ticked.
- A missed hand-off does not go quiet: from day 7 the ticket screen asks whether the person was seen, and the ticket is
  marked overdue when its deadline passes.

No AI is used in scoring, triage or the crisis path. One optional assistant can help the person draft their referral
note, which they edit and approve; it is off by default, and the demo shows it at step 6
([how](docs/running-the-demo.md#the-referral-summary-assistant-at-step-6)).

## Run it

Needs Node 24.11.1, pnpm 12.6.0 and Docker.

```bash
# terminal 1
nvm install              # Node from .nvmrc
npm install -g pnpm@12.6.0
pnpm install
cp .env.example .env     # uncomment DEMO_MODE=true for the demo
pnpm dev                 # Postgres, API :4000, person app :3000, clinician app :3001, ops app :3002 (keeps running)

# terminal 2, once the apps answer
pnpm db:seed             # sample services, 500 simulated tickets, demo staff
```

Then, with `DEMO_MODE=true` set before `pnpm dev`, sign in to the ops app as `admin@demo.mawsool.test` and press
**Reset the demo**: it moves the sample data so it ends
today and prepares the first persona. Staff sign-in links are printed in the API log, not emailed. The other accounts and
the walkthrough are in [Running the demo](docs/running-the-demo.md).

## Repository

```
apps/api         Ticket API (Fastify, Zod, Drizzle, Postgres)
apps/person      The person's app: an installable, offline-capable web app
apps/clinician   The clinic's queue, ticket detail and FHIR export
apps/ops         Dashboard, admin and demo controls, mock crisis-line console
packages/*       Shared types, questionnaires and scoring, matching rules, consent, FHIR, referral-note assistant, UI
```

Checks: `pnpm verify` (lint, typecheck, unit tests, builds, start-up smoke test) and the gates described in
[Technical documentation § 11](docs/technical-documentation.md#11-testing-and-verification).
